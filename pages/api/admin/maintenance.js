import { getSession } from '@auth0/nextjs-auth0';
import { isAdmin } from '../../../lib/auth';
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
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });
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
