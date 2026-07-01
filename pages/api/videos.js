import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getThumbnailUrl } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { getOrder, applyOrder } from '../../lib/order';
import { isAdmin } from '../../lib/auth';
import { allow, callerId } from '../../lib/ratelimit';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  if (!(await allow(callerId(req, session, 'videos')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);

  if (!approved && !isAdmin(email)) {
    return res.status(403).json({ error: 'not_approved' });
  }

  // Track viewer activity for the admin "last seen" column.
  if (approved) await redis.hset(k('viewer_last_seen'), { [email]: Date.now() });

  const storedCount = await redis.get(k('homepage_video_count'));
  const totalLimit = storedCount ? Number(storedCount) : 2;

  const q = (req.query.q || '').trim().toLowerCase();
  const collection = (req.query.collection || '').trim();
  const fetched = await listVideos({ itemsPerPage: 100 });
  const order = await getOrder();
  const ordered = applyOrder(fetched, order);
  // A search or collection filter looks across the whole library; the default
  // (unfiltered) view respects the admin's homepage cap.
  let allVideos;
  if (q) {
    allVideos = ordered.filter((v) => (v.title || '').toLowerCase().includes(q));
  } else if (collection) {
    allVideos = ordered.filter((v) => v.collectionId === collection);
  } else {
    allVideos = ordered.slice(0, totalLimit);
  }

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const start = (page - 1) * perPage;
  const pageVideos = allVideos.slice(start, start + perPage);

  res.json({
    videos: pageVideos.map((v) => ({ id: v.guid, title: v.title, thumbnail: getThumbnailUrl(v) })),
    page,
    totalPages: Math.max(1, Math.ceil(allVideos.length / perPage)),
  });
}
