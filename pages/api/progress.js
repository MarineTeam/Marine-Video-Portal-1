import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser, hasCapability } from '../../lib/roles';
import { allow, callerId } from '../../lib/ratelimit';
import { withMonitorApi } from '../../lib/monitor';

// Per-viewer playback progress / watch history.
// Stored as a Redis hash per user: field = videoId, value = { seconds, duration, title, at }.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  if (!(await allow(callerId(req, session, 'progress')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const email = session.user.email.toLowerCase();
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return res.status(403).json({ error: 'not_approved' });

  const key = k(`progress:${email}`);

  if (req.method === 'GET') {
    const { videoId, email: targetEmail } = req.query;
    if (videoId) {
      const entry = await redis.hget(key, videoId);
      return res.json(entry || null);
    }

    // Admins and managers can look up any viewer's watch history by email
    // (e.g. from the admin panel); everyone else only ever sees their own.
    let lookupKey = key;
    if (targetEmail && targetEmail.toLowerCase() !== email) {
      if (!(await hasCapability(email, 'analytics:read'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      lookupKey = k(`progress:${targetEmail.toLowerCase()}`);
    }

    const all = (await redis.hgetall(lookupKey)) || {};
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

export default withMonitorApi(handler);
