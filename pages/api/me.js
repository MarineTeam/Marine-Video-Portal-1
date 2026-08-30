import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { getRole, capabilitiesForRole, ROLE_ADMIN, ROLE_MANAGER } from '../../lib/roles';
import { withMonitorApi } from '../../lib/monitor';

// "Who am I, and what may I do?" for any logged-in user.
//
// The client used to answer "is this an admin?" by probing
// /api/admin/settings and reading the status code. That worked when admin
// was the only elevated tier; with a Manager role it would report managers
// as plain viewers, because settings is admin-only. This asks the question
// directly instead of inferring it from a 403.
//
// It reveals nothing a caller doesn't already know about themselves: their
// own role and their own capability list.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const role = await getRole(email);
  const staff = role === ROLE_ADMIN || role === ROLE_MANAGER;
  const approved = staff || Boolean(await redis.sismember(k('approved_viewers'), email));

  res.json({
    email,
    role,
    approved,
    isAdmin: role === ROLE_ADMIN,
    isStaff: staff,
    capabilities: capabilitiesForRole(role),
  });
}

export default withMonitorApi(handler);
