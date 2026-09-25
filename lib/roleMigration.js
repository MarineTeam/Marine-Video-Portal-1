// Carries the old fixed Admin / Manager tiers onto custom roles.
//
// Before custom roles, a Redis-granted admin was a member of the set
// pvp:role_admins and a manager a member of pvp:role_managers. Custom roles
// keep neither set. Without this file, the deploy that introduced them would
// find no role for those people and resolve them to no capabilities —
// silently demoted, mid-flight, with no error anywhere. Only ADMIN_EMAILS
// owners would survive, because they never read Redis at all.
//
// So there are two halves, and both are needed:
//
//   1. `legacyCapabilitiesFor` — a READ-TIME fallback consulted by
//      lib/roles.js when someone holds no custom role. Nobody is locked out
//      in the window between deploying and migrating, however long it is.
//   2. `migrateLegacyRoles` — an IDEMPOTENT conversion that creates the two
//      old tiers as real, editable roles ("Admin", "Manager"), assigns them
//      to the people who held them, and only then empties the old sets. Once
//      it has run, half 1 returns [] for everyone.
//
// The mapping is the old capability table exactly: an Admin held every
// capability, a Manager everything but settings:manage and roles:manage.
// Someone who could do a thing yesterday must still be able to do it today,
// or the migration is a silent permission cut by another name.
import { redis, k } from './redis';
import { ALL_CAPABILITIES, LEGACY_MANAGER_CAPABILITIES } from './capabilities';

export const LEGACY_SETS = Object.freeze({ admin: 'role_admins', manager: 'role_managers' });

export const LEGACY_CAPABILITIES = Object.freeze({
  admin: ALL_CAPABILITIES,
  manager: LEGACY_MANAGER_CAPABILITIES,
});

// Fixed ids, so a second run reuses the same records rather than creating a
// second "Admin". They are ordinary role ids, so the Roles section can rename,
// re-scope or delete them like any other.
export const LEGACY_ROLE_IDS = Object.freeze({ admin: 'admin-legacy', manager: 'manager-legacy' });

const LEGACY_ROLE_NAMES = Object.freeze({ admin: 'Admin', manager: 'Manager' });

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Read-time fallback (half 1): the capabilities an un-migrated grant gave
// this address, or [] when there is none — including on any Redis failure,
// because this sits on an authorization path and fails closed like the rest.
// Admin wins if someone is somehow in both sets, as it did under the old tiers.
export async function legacyCapabilitiesFor(email) {
  const e = normalize(email);
  if (!e) return [];
  try {
    const [admin, manager] = await Promise.all([
      redis.sismember(k(LEGACY_SETS.admin), e),
      redis.sismember(k(LEGACY_SETS.manager), e),
    ]);
    if (admin) return [...LEGACY_CAPABILITIES.admin];
    if (manager) return [...LEGACY_CAPABILITIES.manager];
    return [];
  } catch (err) {
    console.error('Could not read a legacy role grant:', err);
    return [];
  }
}

// email -> 'admin' | 'manager' for every grant still in the old sets. Writes
// nothing. Throws on a Redis failure — callers that must not throw catch it.
export async function findLegacyAssignments() {
  const [admins, managers] = await Promise.all([
    redis.smembers(k(LEGACY_SETS.admin)),
    redis.smembers(k(LEGACY_SETS.manager)),
  ]);
  const out = {};
  for (const e of managers || []) if (normalize(e)) out[normalize(e)] = 'manager';
  for (const e of admins || []) if (normalize(e)) out[normalize(e)] = 'admin';
  return out;
}

// The conversion (half 2). Idempotent: a second run finds the old sets empty
// and changes nothing. Returns a summary so the caller reports what happened
// rather than claiming success blindly.
//
// Order is the fail-safe one: create the roles, then write the assignments,
// and only then remove the old grants. A crash at any point leaves someone
// holding BOTH — which resolves to the same capabilities — rather than
// neither.
export async function migrateLegacyRoles() {
  const summary = { migrated: 0, roles: [], emails: [] };
  const legacy = await findLegacyAssignments();
  const emails = Object.keys(legacy);
  if (!emails.length) return summary;

  // 1. One role per old tier in use. HSETNX, so a role an admin has already
  // renamed or re-scoped since an interrupted run is left as they made it.
  const now = new Date().toISOString();
  const tiers = [...new Set(Object.values(legacy))].sort();
  for (const tier of tiers) {
    const id = LEGACY_ROLE_IDS[tier];
    await redis.hsetnx(
      k('roles'),
      id,
      JSON.stringify({
        id,
        name: LEGACY_ROLE_NAMES[tier],
        capabilities: [...LEGACY_CAPABILITIES[tier]],
        createdAt: now,
        updatedAt: now,
      })
    );
  }
  summary.roles = tiers.map((t) => LEGACY_ROLE_NAMES[t]);

  // 2. The assignments, merged with anything already there so a person given
  // a custom role before the migration ran keeps it.
  const existing = (await redis.hgetall(k('user_roles'))) || {};
  const assignments = {};
  for (const [email, tier] of Object.entries(legacy)) {
    const prior = parseIds(existing[email]);
    assignments[email] = JSON.stringify([...new Set([...prior, LEGACY_ROLE_IDS[tier]])].sort());
  }
  await redis.hset(k('user_roles'), assignments);

  // 3. Only now remove the old grants — exactly the ones converted.
  // Every converted address comes out of role_managers, because an admin
  // listed in both sets was converted as an admin and must not stay behind
  // there.
  const admins = emails.filter((e) => legacy[e] === 'admin');
  if (admins.length) await redis.srem(k(LEGACY_SETS.admin), ...admins);
  await redis.srem(k(LEGACY_SETS.manager), ...emails);

  summary.migrated = emails.length;
  summary.emails = emails.sort();
  return summary;
}

// Upstash parses stored JSON on read; a raw string (another client, a test
// double) is parsed here instead.
export function parseIds(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
