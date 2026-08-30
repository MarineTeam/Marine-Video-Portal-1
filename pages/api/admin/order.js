import { requireCapability } from '../../../lib/roles';
import { getOrder, setOrder } from '../../../lib/order';
import { withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;

  if (req.method === 'GET') {
    const order = await getOrder();
    return res.json({ order });
  }

  if (req.method === 'POST') {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    await setOrder(order);
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
