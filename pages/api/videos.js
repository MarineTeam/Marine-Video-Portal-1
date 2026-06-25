import { getSession } from '@auth0/nextjs-auth0';
import { listVideos } from '../../lib/bunny';
import { redis } from '../../lib/redis';
import { getOrder, applyOrder } from '../../lib/order';

function isAdmin(email) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return admins.includes(email);
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember('approved_viewers', email);

  if (!approved && !isAdmin(email)) {
    return res.status(403).json({ error: 'not_approved' });
  }

  const storedCount = await redis.get('homepage_video_count');
  const totalLimit = storedCount ? Number(storedCount) : 2;

  const fetched = await listVideos({ itemsPerPage: 100 });
  const order = await getOrder();
  const ordered = applyOrder(fetched, order);
  const allVideos = ordered.slice(0, totalLimit);

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const start = (page - 1) * perPage;
  const pageVideos = allVideos.slice(start, start + perPage);

  res.json({
    videos: pageVideos.map((v) => ({ id: v.guid, title: v.title })),
    page,
    totalPages: Math.max(1, Math.ceil(allVideos.length / perPage)),
  });
}
