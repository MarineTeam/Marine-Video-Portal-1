import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareLinksEmail, sendBundleEmail } from '../../../lib/mail';
import {
  ttlSecondsFor,
  syncBundleForEmail,
  getBundle,
  listActiveSharesForEmail,
} from '../../../lib/shareBundle';
import crypto from 'crypto';

// Bulk share creation: any number of videos × any number of recipients.
// Every (video, recipient) pair gets its own independently revocable share
// record. Each recipient is emailed at most ONCE per action: a first-ever
// share gets a plain single-link email; once they have 2+ active shares
// (from this action or accumulated over separate ones) every notification
// becomes one consolidated "bundle" email listing everything currently
// active for them, per lib/shareBundle.js.
export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  if (!(await allow(callerId(req, session, 'share')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const body = req.body || {};
  // Accept both the bulk shape (videos: [{id,title}], emails: [...]) and the
  // legacy single shape (videoId, title, email) so existing callers keep working.
  const videos = Array.isArray(body.videos)
    ? body.videos
    : body.videoId
    ? [{ id: body.videoId, title: body.title }]
    : [];
  const emails = Array.isArray(body.emails)
    ? body.emails
    : body.email
    ? [body.email]
    : [];
  const expiresInHours = body.expiresInHours || 72;
  const notify = Boolean(body.notify);
  // Watermark override for every link created by this action: 'always'/'never'
  // is stored on each share record; 'default' (or anything else) is left
  // unset so the share inherits the per-video/global setting at watch time.
  const watermarkMode = body.watermarkMode === 'always' || body.watermarkMode === 'never'
    ? body.watermarkMode
    : undefined;

  const cleanVideos = videos.filter((v) => v && v.id);
  const cleanEmails = [...new Set(emails.map((e) => (e || '').toLowerCase().trim()).filter(Boolean))];

  if (cleanVideos.length === 0 || cleanEmails.length === 0) {
    return res.status(400).json({ error: 'At least one video and one recipient are required' });
  }

  const hours = Math.min(expiresInHours, 720); // capped at 30 days
  const batchId = crypto.randomUUID();
  const baseUrl = process.env.AUTH0_BASE_URL;

  // recipient email -> [{ shareId, videoId, title, watchUrl }]
  const byRecipient = new Map(cleanEmails.map((e) => [e, []]));

  for (const video of cleanVideos) {
    for (const recipient of cleanEmails) {
      const shareId = crypto.randomUUID();
      const expiresAt = Date.now() + hours * 3600 * 1000;
      const share = {
        videoId: video.id,
        title: video.title || '',
        email: recipient,
        expiresAt,
        createdAt: Date.now(),
        batchId,
        views: 0,
        lastViewedAt: null,
        plays: 0,
        lastPlayAt: null,
        furthestPct: 0,
        completed: false,
        completedAt: null,
        ...(watermarkMode ? { watermark: watermarkMode } : {}),
      };
      await redis.set(k(`share:${shareId}`), share, { ex: ttlSecondsFor(expiresAt) });
      await redis.sadd(k('active_shares'), shareId);
      byRecipient.get(recipient).push({
        shareId,
        videoId: video.id,
        title: video.title || '',
        watchUrl: `${baseUrl}/watch/${shareId}`,
      });
    }
  }

  await logAudit(
    actor,
    'share.create',
    `${cleanVideos.length} video(s) → ${cleanEmails.length} recipient(s)`
  );

  // Sync each recipient's bundle (bookkeeping only, independent of `notify`) —
  // "same email, same place": extend an existing bundle, form a new one once
  // they cross 2 active links total, or leave a lone first link unbundled.
  const bundleByRecipient = new Map();
  for (const recipient of cleanEmails) {
    bundleByRecipient.set(recipient, await syncBundleForEmail(recipient));
  }

  // Optionally email each recipient once. Best-effort: a mail failure never
  // fails share creation — links are already stored and can be resent.
  const emailedTo = [];
  if (notify && mailEnabled()) {
    for (const [recipient, links] of byRecipient) {
      const sync = bundleByRecipient.get(recipient);
      let ok;
      if (sync?.bundleId) {
        const bundle = await getBundle(sync.bundleId);
        const allItems = await listActiveSharesForEmail(recipient);
        const items = allItems
          .filter((s) => bundle.itemIds.includes(s.shareId))
          .map((s) => ({ title: s.title, watchUrl: `${baseUrl}/watch/${s.shareId}` }));
        ok = await sendBundleEmail({
          to: recipient,
          bundleUrl: `${baseUrl}/watch/bundle/${sync.bundleId}`,
          items,
          expiresInHours: hours,
        });
      } else {
        ok = await sendShareLinksEmail({
          to: recipient,
          items: links.map(({ title, watchUrl }) => ({ title, watchUrl })),
          expiresInHours: hours,
        });
      }
      if (ok) {
        emailedTo.push(recipient);
        await logAudit(actor, 'share.email', `${links.length} link(s) → ${recipient}`);
      }
    }
  }

  const links = [...byRecipient.values()].flat();
  res.json({
    batchId,
    links,
    expiresInHours: hours,
    recipients: cleanEmails.length,
    emailedTo,
    mailEnabled: mailEnabled(),
  });
}
