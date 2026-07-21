import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';

// Rolls up existing per-share tracking fields (share.js/shares.js already
// write views/plays/furthestPct/completed) into a per-video summary. Reads
// only what's already stored on each active share record — no new tracking.
export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'GET') return res.status(405).end();

  const ids = await redis.smembers(k('active_shares'));
  const byVideo = {};

  for (const id of ids) {
    const share = await redis.get(k(`share:${id}`));
    if (!share) {
      await redis.srem(k('active_shares'), id);
      continue;
    }

    const bucket = (byVideo[share.videoId] ||= {
      shares: 0,
      recipients: new Set(),
      views: 0,
      started: 0,
      completed: 0,
      progressTotal: 0,
    });

    bucket.shares += 1;
    if (share.email) bucket.recipients.add(share.email);
    bucket.views += share.views || 0;
    if (share.plays > 0) bucket.started += 1;
    if (share.completed) bucket.completed += 1;
    bucket.progressTotal += share.furthestPct || 0;
  }

  const result = {};
  for (const [videoId, b] of Object.entries(byVideo)) {
    result[videoId] = {
      shares: b.shares,
      uniqueRecipients: b.recipients.size,
      views: b.views,
      started: b.started,
      completed: b.completed,
      completionRate: b.started > 0 ? Math.round((b.completed / b.started) * 100) : 0,
      avgProgress: b.shares > 0 ? Math.round(b.progressTotal / b.shares) : 0,
    };
  }

  res.json(result);
}
