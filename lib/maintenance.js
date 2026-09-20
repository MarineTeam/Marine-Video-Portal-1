import { redis, k } from './redis';
import { listRoleGrants } from './roles';

// Orphaned per-viewer hashes. These keys are never deleted when a viewer is
// removed (viewers.js only clears their viewer_last_seen field), so a removed
// viewer's data sits in Redis forever — see architecture-contract's
// known-weak-point #3. This removes any such hash whose email is no longer an
// approved viewer or admin.
//
// EVERY per-viewer key family belongs in this list. Adding one and forgetting
// this sweep is how weak-point #3 was created in the first place, and a family
// left out has nothing else that will ever collect it.
const VIEWER_KEY_PREFIXES = ['progress:', 'mylist:', 'ratings:'];

// Keys aren't tracked in a set (nothing needs one on the hot path), so this
// scans each prefix directly — fine for an occasional admin action.
export async function sweepOrphanedViewerData() {
  const approved = new Set(await redis.smembers(k('approved_viewers')));
  // Staff (env admins, plus anyone granted admin/manager in the UI) keep
  // their data even if they were never added as an approved viewer.
  const staff = new Set((await listRoleGrants()).map((g) => g.email));

  let scanned = 0;
  const staleKeys = [];
  for (const suffix of VIEWER_KEY_PREFIXES) {
    const prefix = k(suffix);
    const keys = await redis.keys(`${prefix}*`);
    scanned += keys.length;
    for (const key of keys) {
      const email = key.slice(prefix.length);
      if (!approved.has(email) && !staff.has(email)) staleKeys.push(key);
    }
  }

  if (staleKeys.length) await redis.del(...staleKeys);
  return { scanned, removed: staleKeys.length };
}

// Kept as the old name so nothing that imports it breaks; it now sweeps every
// per-viewer family, not progress alone.
export const sweepOrphanedProgress = sweepOrphanedViewerData;
