import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareEmail } from '../../../lib/mail';
import crypto from 'crypto';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  if (!(await allow(callerId(req, session, 'share')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const { videoId, title, email, expiresInHours = 72, notify = false } = req.body || {};
  if (!videoId || !email) return res.status(400).json({ error: 'videoId and email are required' });

  const recipient = email.toLowerCase().trim();
  const shareId = crypto.randomUUID();
  const hours = Math.min(expiresInHours, 720); // capped at 30 days
  const ttlSeconds = hours * 3600;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  await redis.set(
    k(`share:${shareId}`),
    { videoId, title, email: recipient, expiresAt },
    { ex: ttlSeconds }
  );
  await redis.sadd(k('active_shares'), shareId);
  await logAudit(actor, 'share.create', `${title || videoId} → ${recipient}`);

  const watchUrl = `${process.env.AUTH0_BASE_URL}/watch/${shareId}`;

  // Optionally email the link to the recipient. Best-effort: a mail failure never
  // fails the share creation — the link is already stored and can be copied/resent.
  let emailed = false;
  if (notify && mailEnabled()) {
    emailed = await sendShareEmail({ to: recipient, watchUrl, title, expiresInHours: hours });
    if (emailed) await logAudit(actor, 'share.email', `${title || videoId} → ${recipient}`);
  }

  res.json({ watchUrl, expiresInHours: hours, emailed, mailEnabled: mailEnabled() });
}
