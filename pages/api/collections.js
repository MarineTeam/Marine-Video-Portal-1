import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser } from '../../lib/roles';
import { resolveAccess, filterCollections } from '../../lib/groups';
import { isVerified } from '../../lib/verification';
import { listCollections } from '../../lib/bunny';
import { withMonitorApi } from '../../lib/monitor';

// Collections for the homepage filter — available to any approved viewer.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const email = session.user.email.toLowerCase();
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return res.status(403).json({ error: 'not_approved' });
  if (!(await isVerified(session, { staff }))) {
    return res.status(403).json({ error: 'not_verified' });
  }

  try {
    // A grouped viewer only gets the collections their groups grant —
    // otherwise the homepage filter would offer them collections that always
    // come back empty.
    const access = await resolveAccess(email, { staff });
    res.json(filterCollections(access, await listCollections()));
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to list collections' });
  }
}

export default withMonitorApi(handler);
