import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareLinksEmail } from '../../../lib/mail';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const ids = await redis.smembers(k('active_shares'));
    const shares = [];

    for (const id of ids) {
      const data = await redis.get(k(`share:${id}`));
      if (!data) {
        // Already expired naturally — clean up the stale reference.
        await redis.srem(k('active_shares'), id);
        continue;
      }
      shares.push({ shareId: id, ...data });
    }

    shares.sort((a, b) => a.expiresAt - b.expiresAt);
    return res.json(shares);
  }

  // Resend the email for an existing active link to its original recipient.
  if (req.method === 'POST') {
    if (!(await allow(callerId(req, session, 'share')))) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    if (!mailEnabled()) return res.status(503).json({ error: 'Email is not configured.' });

    const { shareId } = req.body || {};
    if (!shareId) return res.status(400).json({ error: 'shareId required' });

    const share = await redis.get(k(`share:${shareId}`));
    if (!share) return res.status(404).json({ error: 'Link has expired or does not exist.' });

    const watchUrl = `${process.env.AUTH0_BASE_URL}/watch/${shareId}`;
    const hoursLeft = Math.max(1, Math.round((share.expiresAt - Date.now()) / 3600000));
    const emailed = await sendShareLinksEmail({
      to: share.email,
      items: [{ title: share.title, watchUrl }],
      expiresInHours: hoursLeft,
    });
    if (emailed) await logAudit(actor, 'share.resend', `${share.title || share.videoId} → ${share.email}`);
    if (!emailed) return res.status(502).json({ error: 'Email failed to send.' });
    return res.json({ emailed: true });
  }

  if (req.method === 'DELETE') {
    const { shareId } = req.body || {};
    if (!shareId) return res.status(400).json({ error: 'shareId required' });
    await redis.del(k(`share:${shareId}`));
    await redis.srem(k('active_shares'), shareId);
    await logAudit(actor, 'share.revoke', shareId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
