import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser } from '../../lib/roles';
import { getOrCreateToken, rotateToken } from '../../lib/feedTokens';
import { podcastFeedEnabled } from '../../lib/podcastConfig';
import { withMonitorApi } from '../../lib/monitor';

// A viewer's own podcast feed URL. GET returns it (minting one on first ask),
// POST rotates it — the "my feed URL leaked" button.
//
// Requires a session: this is the one place the token is handed out, so it
// must be behind the same login that proves who the viewer is. The feed route
// itself is session-less by necessity; this is not.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return res.status(403).json({ error: 'not_approved' });

  // Inert until the media host is configured, matching how push and email
  // behave: no enclosures means no usable podcast, so don't advertise a feed
  // URL that would produce an empty show.
  if (!podcastFeedEnabled()) {
    return res.json({ enabled: false, feedUrl: null });
  }

  const baseUrl = (process.env.AUTH0_BASE_URL || '').replace(/\/+$/, '');
  const urlFor = (token) => `${baseUrl}/api/feed/${token}`;

  if (req.method === 'GET') {
    const token = await getOrCreateToken(email);
    return res.json({ enabled: true, feedUrl: urlFor(token) });
  }

  if (req.method === 'POST') {
    const token = await rotateToken(email);
    return res.json({ enabled: true, feedUrl: urlFor(token), rotated: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
