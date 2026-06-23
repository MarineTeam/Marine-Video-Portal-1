import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getEmbedUrl } from '../../lib/bunny';
import { redis } from '../../lib/redis';

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

  const limit = parseInt(req.query.limit) || 2;
  const videos = await listVideos({ itemsPerPage: limit });

  res.json(
    videos.map((v) => ({
      id: v.guid,
      title: v.title,
      embedUrl: getEmbedUrl(v.guid, 3600),
    }))
  );
}
