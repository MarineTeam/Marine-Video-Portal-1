import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isAdmin } from '../../lib/auth';

// Per-viewer playback progress / watch history.
// Stored as a Redis hash per user: field = videoId, value = { seconds, duration, title, at }.
export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);
  if (!approved && !isAdmin(email)) return res.status(403).json({ error: 'not_approved' });

  const key = k(`progress:${email}`);

  if (req.method === 'GET') {
    const { videoId } = req.query;
    if (videoId) {
      const entry = await redis.hget(key, videoId);
      return res.json(entry || null);
    }
    const all = (await redis.hgetall(key)) || {};
    const list = Object.entries(all).map(([id, v]) => ({ id, ...v }));
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return res.json(list);
  }

  if (req.method === 'POST') {
    const { videoId, seconds, duration, title } = req.body || {};
    if (!videoId || typeof seconds !== 'number') {
      return res.status(400).json({ error: 'videoId and seconds are required' });
    }
    await redis.hset(key, {
      [videoId]: {
        seconds: Math.floor(seconds),
        duration: Math.floor(duration || 0),
        title: title || '',
        at: Date.now(),
      },
    });
    return res.json({ ok: true });
  }

  res.status(405).end();
}
