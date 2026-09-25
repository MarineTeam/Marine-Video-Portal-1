import { getSession } from './auth0';
import { redis, k } from './redis';
import { isAdmin as isEnvAdmin } from './auth';
import {
  ALL_CAPABILITIES,
  effectiveCapabilities,
  emailsWithCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
} from './capabilities';
import { findLegacyAssignments, LEGACY_CAPABILITIES, legacyCapabilitiesFor, parseIds } from './roleMigration';
import { loadStaffScopes, scopeForEmail } from './staffScopeStore';
import { GLOBAL_CAPABILITIES, capabilitiesUnderScope, contentOfScope } from './staffScopeRules';
import { loadGroupsById } from './groups';

// Roles and capabilities — the ONLY place that decides what a caller may do.
//
// Roles are custom: an owner builds them out of the capability catalog in
// lib/capabilities.js and assigns any number to a person, whose permission is
// the union. Routes name a capability, never a role. Two hashes hold it all:
//
//   pvp:roles       roleId -> { id, name, capabilities[], createdAt, updatedAt }
//   pvp:user_roles  email  -> [roleId, ...]
//
// ADMIN_EMAILS REMAINS AN ALWAYS-WINS FLOOR. Those owners hold every
// capability without Redis being read at all, and nothing in the Roles UI can
// take that away. That is deliberate and load-bearing: it is the recovery
// path if the stored roles are ever emptied, corrupted, or mis-edited, and it
// means a lockout can always be undone from the Vercel dashboard. Never make
// an owner demotable "for consistency" — the consistency you would gain is
// worth less than the lockout you would risk.
//
// lib/auth.js's isAdmin() is unchanged and still means exactly one thing:
// "is this email in ADMIN_EMAILS". It is the floor primitive this consumes.

export {
  ALL_CAPABILITIES,
  CAP,
  CAPABILITY_INFO,
  assignmentNeedsViewerManage,
  canDelegate,
  effectiveCapabilities,
  emailsWithCapability,
  isCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  undelegatableCapabilities,
} from './capabilities';

export const MAX_ROLES = 50;
export const MAX_ROLES_PER_USER = 10;

const ROLES_KEY = 'roles';
const ASSIGNMENTS_KEY = 'user_roles';

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function ownerEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Returns null for anything that is not a usable role record, so a
// hand-edited or half-written row is ignored rather than trusted.
function parseRole(id, value) {
  if (!isValidRoleId(id)) return null;
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = normalizeRoleName(raw.name);
  if (!name) return null;
  return {
    id,
    name,
    capabilities: normalizeCapabilities(raw.capabilities),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

// roleId -> role.
export async function loadRoles() {
  const raw = (await redis.hgetall(k(ROLES_KEY))) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const role = parseRole(id, value);
    if (role) out[id] = role;
  }
  return out;
}

export function sortedRoles(rolesById) {
  return Object.values(rolesById || {}).sort((a, b) => a.name.localeCompare(b.name));
}

// email -> [roleId, ...], for everyone holding at least one role.
export async function loadRoleAssignments() {
  const raw = (await redis.hgetall(k(ASSIGNMENTS_KEY))) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) {
    const ids = parseIds(value);
    if (ids.length && normalize(email)) out[normalize(email)] = ids;
  }
  return out;
}

export async function rolesForEmail(email) {
  const e = normalize(email);
  if (!e) return [];
  return parseIds(await redis.hget(k(ASSIGNMENTS_KEY), e));
}

// The single resolution point behind every guard below. Owners short-circuit
// before any Redis call; everyone else fails CLOSED to no capabilities, since
// an authorization check must never be widened by an infrastructure error.
export async function resolveCapabilities(email) {
  const e = normalize(email);
  if (!e) return [];
  if (isEnvAdmin(e)) return [...ALL_CAPABILITIES];
  try {
    const [roleIds, rolesById] = await Promise.all([rolesForEmail(e), loadRoles()]);
    const caps = effectiveCapabilities({ owner: false, roleIds, rolesById });
    if (caps.length) return caps;
    // Nothing under custom roles yet. Before concluding "nothing", check for
    // an un-migrated Admin / Manager grant — otherwise the deploy that brought
    // custom roles would demote everyone it had not converted yet.
    return await legacyCapabilitiesFor(e);
  } catch (err) {
    console.error('Could not resolve capabilities:', err);
    return [];
  }
}

// Everything a request needs to know about who is asking. `staff` means
// "holds at least one capability" — the admin area is theirs to open, and
// like the old Manager tier they watch the library without being on
// approved_viewers.
//
// A staff member may be limited to certain groups (lib/staffScopeRules.js):
// `staffScope` is then their group ids and `contentScope` what those groups
// grant, and the portal-wide capabilities are stripped. A scope that cannot
// be read leaves them with NO capabilities — never an unscoped set.
export async function getAccess(email) {
  const e = normalize(email);
  const owner = Boolean(e) && isEnvAdmin(e);
  let capabilities = await resolveCapabilities(e);
  let staffScope = null;
  let contentScope = null;
  if (!owner && capabilities.length) {
    try {
      staffScope = await scopeForEmail(e);
      if (staffScope) {
        capabilities = capabilitiesUnderScope(capabilities, staffScope);
        contentScope = contentOfScope(staffScope, await loadGroupsById());
      }
    } catch (err) {
      console.error('Could not resolve a staff scope:', err);
      capabilities = [];
      staffScope = null;
      contentScope = null;
    }
  }
  return { email: e, owner, capabilities, staff: capabilities.length > 0, staffScope, contentScope };
}

export async function hasCapability(email, capability) {
  return (await getAccess(email)).capabilities.includes(capability);
}

export async function isStaffUser(email) {
  return (await getAccess(email)).staff;
}

// Route guard. Returns { session, email, owner, capabilities } on success, or
// null after having already sent a 403 — so a caller writes:
//
//   const auth = await requireCapability(req, res, 'videos:manage');
//   if (!auth) return;
//
// It sends a bare 'Forbidden': a caller who lacks the capability learns
// nothing about which roles hold it. An unknown capability name is held by
// nobody, owners included, so a typo in a route closes the route.
export async function requireCapability(req, res, capability) {
  const session = await getSession(req, res);
  const email = normalize(session?.user?.email);
  if (!session || !email) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  const access = await getAccess(email);
  if (!access.capabilities.includes(capability)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return {
    session,
    email,
    owner: access.owner,
    capabilities: access.capabilities,
    staffScope: access.staffScope,
    contentScope: access.contentScope,
  };
}

// --- Role and assignment storage ----------------------------------------

export async function saveRole(role) {
  if (!isValidRoleId(role?.id)) return { ok: false, error: 'Bad role id' };
  const name = normalizeRoleName(role.name);
  if (!name) return { ok: false, error: 'Bad role name' };
  const record = {
    id: role.id,
    name,
    capabilities: normalizeCapabilities(role.capabilities),
    createdAt: role.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis.hset(k(ROLES_KEY), { [role.id]: JSON.stringify(record) });
  return { ok: true, role: record };
}

// Deleting a role also strips it from everyone holding it, so a stale id can
// never linger in an assignment and quietly come back to life if a future
// record reuses the id.
export async function deleteRole(id) {
  await redis.hdel(k(ROLES_KEY), id);
  const assignments = await loadRoleAssignments();
  for (const [email, ids] of Object.entries(assignments)) {
    if (!ids.includes(id)) continue;
    const next = ids.filter((rid) => rid !== id);
    if (next.length) await redis.hset(k(ASSIGNMENTS_KEY), { [email]: JSON.stringify(next) });
    else await redis.hdel(k(ASSIGNMENTS_KEY), email);
  }
}

// The role list setRolesForEmail would store: live ids only, deduped, capped.
export function cleanRoleIds(roleIds, rolesById) {
  return [...new Set((Array.isArray(roleIds) ? roleIds : []).filter((id) => (rolesById || {})[id]))]
    .slice(0, MAX_ROLES_PER_USER)
    .sort();
}

// Replaces one person's whole role list. Ids with no live role are dropped
// rather than stored, so the hash never accumulates references to nothing.
export async function setRolesForEmail(email, roleIds, rolesById) {
  const e = normalize(email);
  if (!e) return { ok: false, error: 'Bad email' };
  const next = cleanRoleIds(roleIds, rolesById);
  if (next.length) await redis.hset(k(ASSIGNMENTS_KEY), { [e]: JSON.stringify(next) });
  else await redis.hdel(k(ASSIGNMENTS_KEY), e);
  return { ok: true, roleIds: next };
}

// --- Who holds what ------------------------------------------------------

// Everyone holding `cap`, counting owners and grants not yet migrated.
// Throws if the stored roles cannot be read; callers decide what that means.
//
// A portal-wide capability is not held by anyone limited to certain groups
// (lib/staffScopeRules.js strips it), so for those the limited are left out —
// otherwise limiting the last roles:manage holder would pass the "someone can
// still manage roles" check while leaving nobody who can.
export async function holdersOf(cap, { rolesById, assignments, legacy, scopes } = {}) {
  const [roles, assigned, old, limits] = await Promise.all([
    rolesById || loadRoles(),
    assignments || loadRoleAssignments(),
    legacy || findLegacyAssignments(),
    scopes || loadStaffScopes(),
  ]);
  const owners = ownerEmails();
  const legacyHolders = Object.entries(old)
    .filter(([, tier]) => LEGACY_CAPABILITIES[tier]?.includes(cap))
    .map(([email]) => email);
  const holders = emailsWithCapability({
    owners: [...owners, ...legacyHolders],
    assignments: assigned,
    rolesById: roles,
    cap,
  });
  if (!GLOBAL_CAPABILITIES.includes(cap)) return holders;
  return holders.filter((email) => owners.includes(email) || !Array.isArray(limits[email]));
}

// Everyone holding at least one capability — owners, anyone whose roles give
// them something, and old grants not yet migrated. The maintenance sweep keeps
// these people's data and email-verification treats them as staff. THROWS on
// a Redis failure: the sweep must stop rather than decide nobody is staff.
export async function listStaffEmails() {
  const [rolesById, assignments, legacy] = await Promise.all([
    loadRoles(),
    loadRoleAssignments(),
    findLegacyAssignments(),
  ]);
  const out = new Set([...ownerEmails(), ...Object.keys(legacy)]);
  for (const [email, roleIds] of Object.entries(assignments)) {
    if (effectiveCapabilities({ owner: false, roleIds, rolesById }).length) out.add(email);
  }
  return [...out].sort();
}

// Who to tell about something gated on `cap`. Degrades to the owners if the
// stored roles cannot be read: telling fewer of the right people beats
// telling nobody, and this must never throw into the action it describes.
export async function emailsHoldingCapability(cap) {
  try {
    return await holdersOf(cap);
  } catch (err) {
    console.error('Could not resolve capability holders:', err);
    return ownerEmails();
  }
}

export { isEnvAdmin };
