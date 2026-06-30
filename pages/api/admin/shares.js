import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const ids = await redis.smembers(k('active_shares'));
    const shares = [];

    for (const id of ids) {
      const data = await redis.get(k(`share:${id}`));
      if (!data) {
        // Already expired naturally — clean up the stale reference.
        await redis.srem(k('active_shares'), id);
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
    await redis.del(k(`share:${shareId}`));
    await redis.srem(k('active_shares'), shareId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
