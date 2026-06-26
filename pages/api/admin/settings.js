import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const count = await redis.get('homepage_video_count');
    return res.json({ count: count ? Number(count) : 2 });
  }

  if (req.method === 'POST') {
    const { count } = req.body || {};
    const parsed = parseInt(count);
    if (!parsed || parsed < 1 || parsed > 1000) {
      return res.status(400).json({ error: 'count must be between 1 and 1000' });
    }
    await redis.set('homepage_video_count', parsed);
    return res.json({ ok: true, count: parsed });
  }

  res.status(405).end();
}
