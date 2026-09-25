// Group-scoped staff: where a scope is stored.
//
//   pvp:user_scope  email -> [groupId, ...]   (absent = unscoped)
//
// Kept apart from lib/staffScope.js so lib/groups.js and lib/roles.js can both
// read a scope without importing each other. Owners (ADMIN_EMAILS) are never
// scoped: every reader skips this hash for them, and /api/admin/roles refuses
// to write one.
//
// An EMPTY list is stored rather than deleted: absent means "the whole
// portal", so deleting the row when its last group went would widen the person
// to everything.
import { redis, k } from './redis';
import { normalizeScope } from './staffScopeRules';

const KEY = 'user_scope';

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function parse(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  // Present but unreadable is scoped to nothing, never unscoped.
  return normalizeScope(Array.isArray(v) ? v : []);
}

// null (unscoped) or the stored group ids. THROWS on a Redis failure: every
// caller is an access decision and fails closed itself.
export async function scopeForEmail(email) {
  const e = normalize(email);
  if (!e) return null;
  const value = await redis.hget(k(KEY), e);
  return value === null || value === undefined ? null : parse(value);
}

export async function loadStaffScopes() {
  const raw = (await redis.hgetall(k(KEY))) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) out[normalize(email)] = parse(value);
  return out;
}

// null lifts the scope; an array stores it.
export async function setScopeForEmail(email, scope) {
  const e = normalize(email);
  if (!e) return null;
  const next = normalizeScope(scope);
  if (next === null) await redis.hdel(k(KEY), e);
  else await redis.hset(k(KEY), { [e]: JSON.stringify(next) });
  return next;
}
