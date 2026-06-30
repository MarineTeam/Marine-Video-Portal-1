import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, deleteVideo } from '../../../lib/bunny';
import { getOrder, setOrder, applyOrder } from '../../../lib/order';
import { isAdmin } from '../../../lib/auth';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const videos = await listVideos({ itemsPerPage: 100 });
    const order = await getOrder();
    const ordered = applyOrder(videos, order);

    return res.json(
      ordered.map((v) => ({
        id: v.guid,
        title: v.title,
        dateUploaded: v.dateUploaded,
        status: v.status,
        encodeProgress: v.encodeProgress,
      }))
    );
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await deleteVideo(id);
    } catch (e) {
      return res.status(502).json({ error: e.message || 'Failed to delete video' });
    }
    // Drop the deleted id from the saved custom order so it doesn't linger.
    const order = await getOrder();
    if (order.includes(id)) await setOrder(order.filter((x) => x !== id));
    return res.json({ ok: true });
  }

  res.status(405).end();
}
