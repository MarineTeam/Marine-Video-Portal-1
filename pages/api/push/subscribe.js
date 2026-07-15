import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { allow, callerId } from '../../../lib/ratelimit';
import { pushEnabled } from '../../../lib/push';

// Store a browser's Web Push subscription for the logged-in viewer. Keyed by the
// subscription endpoint so re-subscribing the same device is idempotent.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  if (!(await allow(callerId(req, session, 'push')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);
  if (!approved && !isAdmin(email)) return res.status(403).json({ error: 'not_approved' });

  if (!pushEnabled()) return res.status(503).json({ error: 'Push notifications are not configured' });

  const sub = req.body && req.body.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== 'string' ||
    !/^https:\/\//.test(sub.endpoint) ||
    !sub.keys ||
    typeof sub.keys.p256dh !== 'string' ||
    typeof sub.keys.auth !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  await redis.hset(k(`push_subs:${email}`), { [sub.endpoint]: JSON.stringify(sub) });
  return res.json({ ok: true });
}
