import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from './redis';
import { isAdmin as isEnvAdmin } from './auth';

// Roles and capabilities.
//
// The portal used to have exactly two tiers: admin (ADMIN_EMAILS) and
// approved viewer. This module adds a Manager tier in between and lets an
// admin grant either role from the UI instead of editing a Vercel env var.
//
// ADMIN_EMAILS REMAINS AN ALWAYS-WINS FLOOR. An email listed there is an
// admin no matter what Redis says, and `revokeRole` refuses to demote one.
// That is deliberate and load-bearing: it is the recovery path if the
// Redis-backed grants are ever emptied, corrupted, or mis-edited, and it
// means an admin lockout can always be undone from the Vercel dashboard.
// Never make an env admin demotable "for consistency" — the consistency you
// would gain is worth less than the lockout you would risk.
//
// lib/auth.js's isAdmin() is unchanged and still means exactly one thing:
// "is this email in ADMIN_EMAILS". It is the floor primitive that this
// module consumes. Every route asks THIS module instead, so there is still
// a single place that decides what a caller may do.

export const ROLE_ADMIN = 'admin';
export const ROLE_MANAGER = 'manager';
export const ROLE_VIEWER = 'viewer';
export const ROLE_NONE = 'none';

// Capability → the roles that hold it. Routes name a capability, never a
// role, so widening or narrowing what a Manager can do is a one-line edit
// here rather than a sweep through pages/api/admin/*.
export const CAPABILITIES = {
  'videos:manage': [ROLE_ADMIN, ROLE_MANAGER], // upload, rename, delete, collections, order
  'shares:manage': [ROLE_ADMIN, ROLE_MANAGER], // share links, bulk share, private lists
  'viewers:manage': [ROLE_ADMIN, ROLE_MANAGER], // approve/remove viewers, viewer tags
  'groups:manage': [ROLE_ADMIN, ROLE_MANAGER], // groups and their content grants
  'analytics:read': [ROLE_ADMIN, ROLE_MANAGER],
  'audit:read': [ROLE_ADMIN, ROLE_MANAGER],
  // Admin-only: anything that reshapes the portal itself or hands out power.
  'settings:manage': [ROLE_ADMIN], // homepage count, theme, geo, watermark, maintenance, broadcast
  'roles:manage': [ROLE_ADMIN], // promote/demote admins and managers
};

export const MANAGER_CAPABILITIES = Object.keys(CAPABILITIES).filter((c) =>
  CAPABILITIES[c].includes(ROLE_MANAGER)
);

const ADMINS_KEY = 'role_admins';
const MANAGERS_KEY = 'role_managers';

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Resolve a caller's role. Redis failures degrade to the env floor rather
// than throwing: an Upstash blip must never lock the configured admins out
// of their own portal (and it can only ever REMOVE a grant, never invent
// one, so degrading this way cannot escalate anybody).
export async function getRole(email) {
  const e = normalize(email);
  if (!e) return ROLE_NONE;
  if (isEnvAdmin(e)) return ROLE_ADMIN;

  try {
    const [admin, manager] = await Promise.all([
      redis.sismember(k(ADMINS_KEY), e),
      redis.sismember(k(MANAGERS_KEY), e),
    ]);
    if (admin) return ROLE_ADMIN;
    if (manager) return ROLE_MANAGER;
  } catch {
    // Fall through to the viewer/none determination below.
  }

  try {
    if (await redis.sismember(k('approved_viewers'), e)) return ROLE_VIEWER;
  } catch {
    return ROLE_NONE;
  }
  return ROLE_NONE;
}

// Pure: does this role hold this capability? Unknown capability names return
// false so a typo in a route fails closed instead of opening the route.
export function roleHasCapability(role, capability) {
  const holders = CAPABILITIES[capability];
  if (!holders) return false;
  return holders.includes(role);
}

export function capabilitiesForRole(role) {
  return Object.keys(CAPABILITIES).filter((c) => roleHasCapability(role, c));
}

export async function hasCapability(email, capability) {
  return roleHasCapability(await getRole(email), capability);
}

// Convenience wrappers for the places that genuinely care about the tier
// rather than a specific capability (page gates, audit copy, nav links).
export async function isAdminUser(email) {
  return (await getRole(email)) === ROLE_ADMIN;
}

export async function isStaffUser(email) {
  const role = await getRole(email);
  return role === ROLE_ADMIN || role === ROLE_MANAGER;
}

// Route guard. Returns { session, email, role } on success, or null after
// having already sent a 401/403 — so a caller writes:
//
//   const auth = await requireCapability(req, res, 'videos:manage');
//   if (!auth) return;
//
// It sends the same bare 'Forbidden' the old isAdmin() gates did: a caller
// who lacks the capability learns nothing about which roles hold it.
export async function requireCapability(req, res, capability) {
  const session = await getSession(req, res);
  const email = normalize(session?.user?.email);
  if (!session || !email) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  const role = await getRole(email);
  if (!roleHasCapability(role, capability)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return { session, email, role };
}

// --- Grant management -------------------------------------------------

export async function listRoleGrants() {
  const [admins, managers] = await Promise.all([
    redis.smembers(k(ADMINS_KEY)),
    redis.smembers(k(MANAGERS_KEY)),
  ]);
  const envAdmins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // An env admin shows up as an admin whose grant cannot be removed here;
  // the UI renders that as a locked row pointing at ADMIN_EMAILS.
  const rows = new Map();
  for (const e of managers || []) rows.set(e, { email: e, role: ROLE_MANAGER, locked: false });
  for (const e of admins || []) rows.set(e, { email: e, role: ROLE_ADMIN, locked: false });
  for (const e of envAdmins) rows.set(e, { email: e, role: ROLE_ADMIN, locked: true });

  return [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// Grant admin or manager. Roles are exclusive: granting one clears the
// other, so a demotion from admin to manager is a single call and can never
// leave someone holding both sets.
export async function grantRole(email, role) {
  const e = normalize(email);
  if (!e) throw new Error('email required');
  if (role !== ROLE_ADMIN && role !== ROLE_MANAGER) throw new Error('unknown role');

  if (isEnvAdmin(e) && role === ROLE_MANAGER) {
    // Writing the grant would be a lie: getRole() short-circuits on the env
    // floor, so this person would still resolve as admin.
    throw new Error('That email is an admin via ADMIN_EMAILS and cannot be demoted here.');
  }

  if (role === ROLE_ADMIN) {
    await redis.sadd(k(ADMINS_KEY), e);
    await redis.srem(k(MANAGERS_KEY), e);
  } else {
    await redis.sadd(k(MANAGERS_KEY), e);
    await redis.srem(k(ADMINS_KEY), e);
  }
  return { email: e, role };
}

export async function revokeRole(email) {
  const e = normalize(email);
  if (!e) throw new Error('email required');
  if (isEnvAdmin(e)) {
    throw new Error('That email is an admin via ADMIN_EMAILS — remove it there instead.');
  }
  await redis.srem(k(ADMINS_KEY), e);
  await redis.srem(k(MANAGERS_KEY), e);
  return { email: e, role: ROLE_VIEWER };
}

// Would revoking/demoting this email leave the portal with no admin who can
// still administer it? Callers use this to refuse the last demotion. Env
// admins are counted because they are exactly the recovery path.
export async function countRemainingAdmins(excludingEmail) {
  const excluded = normalize(excludingEmail);
  const grants = await listRoleGrants();
  return grants.filter((g) => g.role === ROLE_ADMIN && g.email !== excluded).length;
}

export { isEnvAdmin };
