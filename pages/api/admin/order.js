import { requireCapability } from '../../../lib/roles';
import { SCOPED_REFUSAL } from '../../../lib/staffScope';
import { isScoped } from '../../../lib/staffScopeRules';
import { getOrder, setOrder } from '../../../lib/order';
import { withMonitorApi } from '../../../lib/monitor';
import { MAX_LIBRARY_VIDEOS } from '../../../lib/videoLibrary';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;

  if (req.method === 'GET') {
    const order = await getOrder();
    // A scoped caller sees only their own videos' places in it — the scope
    // names its videos directly or through their collection, and the order
    // holds ids only, so an id the scope does not name is left out.
    if (isScoped(auth)) {
      const mine = new Set(auth.contentScope?.videoIds || []);
      return res.json({ order: order.filter((id) => mine.has(id)) });
    }
    return res.json({ order });
  }

  if (req.method === 'POST') {
    // The homepage order is one list for everyone.
    if (isScoped(auth)) return res.status(403).json({ error: SCOPED_REFUSAL });
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
