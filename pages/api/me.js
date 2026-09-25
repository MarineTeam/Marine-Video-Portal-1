import { getSession } from '../../lib/auth0';
import { redis, k } from '../../lib/redis';
import { getAccess } from '../../lib/roles';
import { withMonitorApi } from '../../lib/monitor';

// "Who am I, and what may I do?" for any logged-in user.
//
// The client used to answer "is this an admin?" by probing
// /api/admin/settings and reading the status code. With custom roles that
// would report most staff as plain viewers, because settings is one
// capability among many. This asks the question directly instead of
// inferring it from a 403.
//
// It reveals nothing a caller doesn't already know about themselves: whether
// they are an owner (ADMIN_EMAILS) and their own capability list.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const access = await getAccess(email);
  const approved = access.staff || Boolean(await redis.sismember(k('approved_viewers'), email));

  res.json({
    email,
    approved,
    owner: access.owner,
    isStaff: access.staff,
    capabilities: access.capabilities,
  });
}

export default withMonitorApi(handler);
