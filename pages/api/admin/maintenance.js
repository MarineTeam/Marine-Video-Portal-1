import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import { sweepStaleBundles, reapActiveShares } from '../../../lib/shareBundle';
import { sweepOrphanedProgress } from '../../../lib/maintenance';
import { withMonitorApi } from '../../../lib/monitor';

// One admin-triggered sweep for stale data that nothing else ever cleans up:
// bundles whose members have all expired/been revoked, active_shares entries
// whose records already fell out of Redis, and orphaned per-viewer progress
// hashes left behind by removed viewers. Each sub-sweep is independent, so
// one failing never blocks the others.
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

  const removed = bundles.removed + shares.removed + progress.removed;
  if (removed) {
    await logAudit(
      actor,
      'maintenance.cleanup',
      `${bundles.removed} bundle(s), ${shares.removed} stale share ref(s), ${progress.removed} orphaned progress record(s)`
    );
  }

  res.json({ bundles, shares, progress });
}

export default withMonitorApi(handler);
