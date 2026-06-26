import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';


export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const viewers = await redis.smembers('approved_viewers');
    return res.json((viewers || []).sort());
  }

  if (req.method === 'POST') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    await redis.sadd('approved_viewers', email.toLowerCase().trim());
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    await redis.srem('approved_viewers', email.toLowerCase().trim());
    return res.json({ ok: true });
  }

  res.status(405).end();
}
