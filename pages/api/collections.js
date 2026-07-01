import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isAdmin } from '../../lib/auth';
import { listCollections } from '../../lib/bunny';

// Collections for the homepage filter — available to any approved viewer.
export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);
  if (!approved && !isAdmin(email)) return res.status(403).json({ error: 'not_approved' });

  try {
    res.json(await listCollections());
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to list collections' });
  }
}
