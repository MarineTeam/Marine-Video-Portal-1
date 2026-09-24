import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import { sweepStaleBundles, reapActiveShares } from '../../../lib/shareBundle';
import { sweepOrphanedProgress } from '../../../lib/maintenance';
import { recountRatings } from '../../../lib/ratingsStore';
import { withMonitorApi } from '../../../lib/monitor';

// One admin-triggered sweep for stale data that nothing else ever cleans up:
// bundles whose members have all expired/been revoked, active_shares entries
// whose records already fell out of Redis, and orphaned per-viewer progress
// hashes left behind by removed viewers — then a rebuild of the rating totals
// from the votes that remain.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;
  if (req.method !== 'POST') return res.status(405).end();

  const [bundles, shares, progress] = await Promise.all([
    sweepStaleBundles(),
    reapActiveShares(),
    sweepOrphanedProgress(),
  ]);

  // AFTER the per-viewer sweep, never beside it: that sweep deletes a removed
  // viewer's whole ratings hash, and nothing else can take their votes back
  // out of the totals. Rebuilding the counters from the votes that remain
  // makes the two agree again — and corrects any drift from before votes and
  // totals were written in one script. Its failure is reported, not thrown:
  // the sweeps above already happened and the admin is owed their result.
  let ratings;
  try {
    ratings = await recountRatings();
  } catch (e) {
    console.error('Could not recount ratings:', e);
    ratings = { error: 'Could not recount ratings' };
  }

  const removed = bundles.removed + shares.removed + progress.removed;
  if (removed) {
    await logAudit(
      actor,
      'maintenance.cleanup',
      `${bundles.removed} bundle(s), ${shares.removed} stale share ref(s), ${progress.removed} orphaned progress record(s)`
    );
  }

  if (!ratings.error) {
    await logAudit(
      actor,
      'ratings.recount',
      `Recounted ${ratings.votes} vote(s) from ${ratings.viewers} viewer(s)`
    );
  }

  res.json({ bundles, shares, progress, ratings });
}

export default withMonitorApi(handler);
