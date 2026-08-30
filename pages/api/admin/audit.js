import { requireCapability } from '../../../lib/roles';
import { getAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'audit:read');
  if (!auth) return;
  if (req.method !== 'GET') return res.status(405).end();

  const entries = await getAudit(100);
  res.json(entries);
}

export default withMonitorApi(handler);
