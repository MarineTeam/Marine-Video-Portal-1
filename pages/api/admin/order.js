import { requireCapability } from '../../../lib/roles';
import { getOrder, setOrder } from '../../../lib/order';
import { withMonitorApi } from '../../../lib/monitor';
import { MAX_LIBRARY_VIDEOS } from '../../../lib/videoLibrary';

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
    // The Videos tab saves the order of the whole list it shows, which is at
    // most a whole-library read (lib/videoLibrary.js). Anything longer, or
    // holding something other than an id, did not come from that tab.
    if (
      order.length > MAX_LIBRARY_VIDEOS ||
      order.some((id) => typeof id !== 'string' || !id || id.length > 64)
    ) {
      return res.status(400).json({ error: 'Bad order' });
    }
    await setOrder(order);
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
