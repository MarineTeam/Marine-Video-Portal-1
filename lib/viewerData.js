// What is deleted when a viewer is removed (pages/api/admin/viewers.js).
//
// Decided by the owner (2026-10-11): removing someone deletes what was
// recorded about them — their votes (taken back out of the totals), their
// watch progress, their saved list and their comments. Re-adding them later
// starts them from nothing.
//
// The route calls this BEFORE taking their access away. If any part fails it
// throws, the route answers 502 and they stay on the list, so the admin can
// simply remove them again — run after the removal, a failure would leave data
// that only the maintenance sweep (lib/maintenance.js) could find, and that
// sweep cannot take votes back out of the totals or reach comments at all.
//
// EVERY per-viewer key family belongs here AND in the sweep's
// VIEWER_KEY_PREFIXES. Adding one and forgetting either is exactly how the gap
// this closes came about.
import { redis, k } from './redis';
import { deleteCommentsBy } from './commentsStore';
import { forgetRatings } from './ratingsStore';

export async function forgetViewerData(email) {
  const e = String(email || '').trim().toLowerCase();
  const votes = await forgetRatings(e);
  await redis.del(k(`progress:${e}`), k(`mylist:${e}`));
  const comments = await deleteCommentsBy(e);
  return { votes, comments };
}
