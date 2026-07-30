import { getSession } from '@auth0/nextjs-auth0';
import { isAdmin } from '../../../lib/auth';
import { getAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'GET') return res.status(405).end();

  const entries = await getAudit(100);
  res.json(entries);
}

export default withMonitorApi(handler);
