import { getSession } from '../../lib/auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser, getAccess } from '../../lib/roles';
import { isScoped, personInScope } from '../../lib/staffScopeRules';
import { groupIdsForEmail, loadGroupsById } from '../../lib/groups';
import { allow, callerId } from '../../lib/ratelimit';
import { withMonitorApi } from '../../lib/monitor';
import { isVideoId } from '../../lib/bunny';
import { progressTitle } from '../../lib/progress';
import { saveProgress } from '../../lib/progressStore';

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
      const who = await getAccess(email);
      if (!who.capabilities.includes('analytics:read')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // A group-scoped caller reads only their own groups' people; anyone else
      // answers exactly like someone with no history.
      if (isScoped(who)) {
        let inScope = false;
        try {
          const [theirs, groupsById] = await Promise.all([
            groupIdsForEmail(targetEmail.toLowerCase()),
            loadGroupsById(),
          ]);
          inScope = personInScope(who, theirs, groupsById);
        } catch {
          inScope = false;
        }
        if (!inScope) return res.json([]);
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
    // A bunny video id, a real position, and a bounded title — see
    // lib/progress.js for what this used to accept.
    if (!isVideoId(videoId) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      return res.status(400).json({ error: 'videoId and seconds are required' });
    }
    const length = Number(duration);
    // At most MAX_PROGRESS_ENTRIES videos per viewer (lib/progressStore.js).
    await saveProgress(email, videoId, {
      seconds: Math.floor(seconds),
      duration: Number.isFinite(length) && length > 0 ? Math.floor(length) : 0,
      title: progressTitle(title),
      at: Date.now(),
    });
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
