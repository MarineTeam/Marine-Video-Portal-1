import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const count = await redis.get('homepage_video_count');
    return res.json({ count: count ? Number(count) : 2 });
  }

  if (req.method === 'POST') {
    const { count } = req.body || {};
    const parsed = parseInt(count);
    if (!parsed || parsed < 1 || parsed > 50) {
      return res.status(400).json({ error: 'count must be between 1 and 50' });
    }
    await redis.set('homepage_video_count', parsed);
    return res.json({ ok: true, count: parsed });
  }

  res.status(405).end();
}
