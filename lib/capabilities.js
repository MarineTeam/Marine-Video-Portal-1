// The capability catalog and the pure decision logic of the role system.
//
// PURE MODULE — no Redis import. pages/admin.js reads capability names from
// here, so anything imported here reaches the browser bundle; pulling
// lib/redis.js in would drag Node built-ins (async_hooks, via lib/monitor.js)
// into that bundle and fail the build. Storage lives in lib/roles.js.
//
// Roles are ADMIN-DEFINED, not fixed. The old Admin / Manager tiers are gone:
// an owner builds roles out of the catalog below and assigns any number of
// them to a person, whose effective permission is the union. Four properties
// are load-bearing, each with a test in lib/__tests__/capabilities.test.js:
//
//   1. Capabilities are defined HERE, in code — never in Redis. Every name
//      below is one a route actually enforces (`requireCapability(req, res,
//      '<name>')`). An admin-invented capability would grant nothing while
//      reading as though it did, so unknown names are dropped on write and
//      ignored on read, and a route naming an unknown one is closed to all.
//   2. ADMIN_EMAILS holds every capability, always, resolved without touching
//      Redis (lib/roles.js). Those owners are the non-removable bootstrap set
//      and the lockout-recovery path: Redis can only ADD privilege to other
//      people, never subtract from an owner.
//   3. No self-escalation: an actor may only create, edit, delete or assign a
//      role whose capabilities are a SUBSET of their own (`canDelegate`).
//      Someone holding roles:manage can hand out what they already hold and
//      nothing more. Owners hold everything, so the rule is invisible to them
//      and a hard ceiling for everyone else.
//   4. Resolution fails CLOSED — a non-owner whose capabilities cannot be read
//      resolves to none (lib/roles.js). An Upstash blip can only ever remove a
//      grant, never invent one.

export const CAP = Object.freeze({
  VIDEOS_MANAGE: 'videos:manage',
  SHARES_MANAGE: 'shares:manage',
  VIEWERS_MANAGE: 'viewers:manage',
  GROUPS_MANAGE: 'groups:manage',
  COMMENTS_MANAGE: 'comments:manage',
  ANALYTICS_READ: 'analytics:read',
  AUDIT_READ: 'audit:read',
  SETTINGS_MANAGE: 'settings:manage',
  ROLES_MANAGE: 'roles:manage',
});

export const ALL_CAPABILITIES = Object.freeze(Object.values(CAP).sort());

// Shown in the Roles editor. Kept beside the catalog so a new capability
// cannot reach the UI unlabelled.
export const CAPABILITY_INFO = Object.freeze([
  { cap: CAP.VIDEOS_MANAGE, group: 'Videos', label: 'Upload, rename, delete, order and schedule videos; collections and transcripts' },
  { cap: CAP.SHARES_MANAGE, group: 'Videos', label: 'Create and revoke share links and private lists' },
  { cap: CAP.VIEWERS_MANAGE, group: 'People', label: 'Approve, remove and tag viewers; answer access requests' },
  { cap: CAP.GROUPS_MANAGE, group: 'People', label: 'Manage groups and what they can see' },
  { cap: CAP.COMMENTS_MANAGE, group: 'People', label: "Remove any viewer's comment" },
  { cap: CAP.ANALYTICS_READ, group: 'Insight', label: "View analytics and viewers' watch history" },
  { cap: CAP.AUDIT_READ, group: 'Insight', label: 'Read the activity log' },
  { cap: CAP.SETTINGS_MANAGE, group: 'Portal', label: 'Change settings, publish public links, send broadcasts' },
  { cap: CAP.ROLES_MANAGE, group: 'Portal', label: 'Create roles and decide who holds them' },
]);

// What the old Manager tier held — everything but settings and roles. The
// legacy migration (lib/roleMigration.js) turns it into an editable role.
export const LEGACY_MANAGER_CAPABILITIES = Object.freeze(
  ALL_CAPABILITIES.filter((c) => c !== CAP.SETTINGS_MANAGE && c !== CAP.ROLES_MANAGE)
);

export function isCapability(cap) {
  return ALL_CAPABILITIES.includes(cap);
}

// Drop unknowns, dedupe, sort — applied to everything written to or read from
// Redis, so a hand-edited record can never widen the catalog (property 1).
export function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isCapability))].sort();
}

// An owner's set is the whole catalog and never depends on stored data
// (property 2). For everyone else it is the union of their roles'
// capabilities; a role id with no surviving record contributes nothing.
export function effectiveCapabilities({ owner, roleIds, rolesById } = {}) {
  if (owner) return [...ALL_CAPABILITIES];
  const out = new Set();
  for (const id of Array.isArray(roleIds) ? roleIds : []) {
    const role = (rolesById || {})[id];
    for (const cap of normalizeCapabilities(role?.capabilities)) out.add(cap);
  }
  return [...out].sort();
}

// Property 3 in one line: you may only hand out what you hold.
export function canDelegate(actorCaps, requestedCaps) {
  return undelegatableCapabilities(actorCaps, requestedCaps).length === 0;
}

// The capabilities in `requestedCaps` the actor cannot hand out — so a 403 can
// name them rather than being a bare refusal.
export function undelegatableCapabilities(actorCaps, requestedCaps) {
  const held = new Set(Array.isArray(actorCaps) ? actorCaps : []);
  return normalizeCapabilities(requestedCaps).filter((cap) => !held.has(cap));
}

// Property 3 has a blind spot the subset rule alone cannot see. Giving
// someone a role also approves them as a viewer (pages/api/admin/roles.js
// adds them to approved_viewers, as granting Manager always did), and
// approving a viewer is what viewers:manage gates. A roles:manage holder
// without viewers:manage could otherwise let a stranger into the library by
// handing them any capability they do hold.
//
// So a first foothold for someone not already approved additionally needs
// viewers:manage. Owners, removals (nothing granted) and people already
// approved are unaffected — only the case that widens who can watch is.
export function assignmentNeedsViewerManage({ owner, actorCaps, grantedCaps, targetApproved } = {}) {
  if (owner) return false;
  if ((actorCaps || []).includes(CAP.VIEWERS_MANAGE)) return false;
  if (targetApproved) return false;
  return normalizeCapabilities(grantedCaps).length > 0;
}

// Everyone who holds `cap`: the owners (who hold the whole catalog) plus every
// assignee whose roles union to include it. Pure: the caller supplies the
// already-normalized owner addresses and the two stored maps.
export function emailsWithCapability({ owners = [], assignments = {}, rolesById = {}, cap } = {}) {
  const out = new Set(owners.filter(Boolean));
  for (const [email, roleIds] of Object.entries(assignments || {})) {
    if (effectiveCapabilities({ owner: false, roleIds, rolesById }).includes(cap)) out.add(email);
  }
  return [...out].sort();
}

export const MAX_ROLE_NAME_LENGTH = 60;

export function normalizeRoleName(raw) {
  const name = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ROLE_NAME_LENGTH);
  return name || null;
}

// Ids are derived from the name but stable once created, so renaming a role
// never changes its id and assignments survive a rename. The random suffix
// keeps two roles named alike from collapsing into one record.
export function roleIdFromName(name, rand = () => Math.random().toString(36).slice(2, 8)) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${slug || 'role'}-${rand()}`;
}

// Lowercase letters, digits and hyphens only — never "@" or ".", so a role id
// can never be mistaken for an email address anywhere the two meet.
export function isValidRoleId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}
