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
    const ids = await redis.smembers('active_shares');
    const shares = [];

    for (const id of ids) {
      const data = await redis.get(`share:${id}`);
      if (!data) {
        // Already expired naturally — clean up the stale reference.
        await redis.srem('active_shares', id);
        continue;
      }
      shares.push({ shareId: id, ...data });
    }

    shares.sort((a, b) => a.expiresAt - b.expiresAt);
    return res.json(shares);
  }

  if (req.method === 'DELETE') {
    const { shareId } = req.body || {};
    if (!shareId) return res.status(400).json({ error: 'shareId required' });
    await redis.del(`share:${shareId}`);
    await redis.srem('active_shares', shareId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
