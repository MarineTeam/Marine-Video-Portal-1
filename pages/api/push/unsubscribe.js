import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { withMonitorApi } from '../../../lib/monitor';

// Remove a browser's Web Push subscription for the logged-in viewer. No approval
// check: anyone signed in may always unsubscribe their own device.
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'endpoint required' });
  }

  await redis.hdel(k(`push_subs:${email}`), endpoint);
  return res.json({ ok: true });
}

export default withMonitorApi(handler);
