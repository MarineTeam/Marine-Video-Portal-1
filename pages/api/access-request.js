import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser } from '../../lib/roles';
import { submitRequest, getRequest } from '../../lib/accessRequests';
import { allow, callerId } from '../../lib/ratelimit';
import { withMonitorApi } from '../../lib/monitor';

// The unapproved user's half of the access-request flow. Requires a session —
// the request is only meaningful because Auth0 already proved the email, and
// an unauthenticated version of this endpoint would be an open spam funnel.
//
// It cannot grant anything. It writes one record to pvp:access_requests and
// nothing else; approving is /api/admin/access-requests, behind
// 'viewers:manage'. Deliberately rate-limited (it is reachable by anyone who
// can sign in, which is a wider audience than any other write path here).
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  if (!(await allow(callerId(req, session, 'access-request')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const email = session.user.email.toLowerCase();

  // Someone who already has access has nothing to request. Answering plainly
  // keeps the homepage from offering the button to a viewer whose approval
  // landed in another tab.
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (approved || staff) return res.json({ ok: true, alreadyApproved: true });

  if (req.method === 'GET') {
    const existing = await getRequest(email);
    return res.json({ ok: true, request: existing, alreadyApproved: false });
  }

  if (req.method === 'POST') {
    try {
      const { record, alreadyPending } = await submitRequest(email, (req.body || {}).note);
      return res.json({ ok: true, request: record, alreadyPending });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
