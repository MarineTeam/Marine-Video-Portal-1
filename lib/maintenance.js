import { redis, k } from './redis';
import { isAdmin } from './auth';

// Orphaned per-viewer watch-history hashes: pvp:progress:{email} is never
// deleted when a viewer is removed (viewers.js only clears their
// viewer_last_seen field), so a removed viewer's progress hash sits in Redis
// forever — see architecture-contract's known-weak-point #3. This removes
// any progress hash whose email is no longer an approved viewer or admin.
// Keys aren't tracked in a set (nothing needs one on the hot path), so this
// scans `progress:*` directly — fine for an occasional admin action.
export async function sweepOrphanedProgress() {
  const prefix = k('progress:');
  const keys = await redis.keys(`${prefix}*`);
  if (!keys.length) return { scanned: 0, removed: 0 };

  const approved = new Set(await redis.smembers(k('approved_viewers')));
  const staleKeys = keys.filter((key) => {
    const email = key.slice(prefix.length);
    return !approved.has(email) && !isAdmin(email);
  });

  if (staleKeys.length) await redis.del(...staleKeys);
  return { scanned: keys.length, removed: staleKeys.length };
}
