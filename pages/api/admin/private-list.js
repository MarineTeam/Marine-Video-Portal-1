import { requireCapability } from '../../../lib/roles';
import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareLinksEmail, sendBundleEmail } from '../../../lib/mail';
import {
  getShares,
  saveShares,
  syncBundlesForEmails,
  getBundle,
  listActiveSharesForEmail,
  listActiveSharesForVideo,
  isExpired,
} from '../../../lib/shareBundle';
import crypto from 'crypto';
import { withMonitorApi } from '../../../lib/monitor';

// Per-video "Private list": a persistent, editable set of emails with
// standing access to one video — YouTube/Drive-style "share with specific
// people", layered on top of the existing Share / Bulk Share machinery
// rather than a parallel data model. Under the hood a list member IS a
// share record (lib/shareBundle.js), so extend/resend from the Shares tab
// and bundle notifications keep working on it exactly like any other share.
//
// The list is scoped to the tokens IT created, and only those: every share
// this route creates is tagged `privateList: true`, and every membership
// check (who's "on the list", what add diffs against, what remove revokes)
// filters on that tag. Two consequences fall out of that on purpose:
//   - If the same video/email pair already has a share from Create Link or
//     Bulk Share (no tag), adding them here still creates a brand-new,
//     independently-revocable share — the list has no way to see, and
//     therefore no way to skip or clobber, a token it didn't create.
//   - Removing someone here revokes only the list's own token. Any other
//     active share to that same video/email (created via Create Link/Bulk
//     Share, or a stray earlier one) is completely unaffected — "remove"
//     is never a global "wipe this person's access to this video" action.
// A different video's list is a fully separate set of tagged shares, so
// removing someone from video A's list never touches video B's. And since
// revoke never touches bundle membership (see shareBundle.js), removing a
// bundled list share just makes the bundle page quietly stop listing that
// one video next load — every other bundle member is untouched.
//
// Adding an email already active on this list is a no-op — no duplicate
// share, no re-sent notification. Re-adding a since-removed email creates a
// brand new (untagged-history) share, since the revoked one no longer
// counts as "on the list".
const MAX_HOURS = 720; // 30 days — same cap as /api/admin/share; list shares
// are just shares, so they ride the same expiry ceiling as everything else.

// One GET returns every video's current list in one shot (mirrors
// video-analytics.js's single-scan, group-by-video shape) so the admin UI
// can fetch once on load instead of once per row.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'shares:manage');
  if (!auth) return;
  const { session, email: actor } = auth;

  if (req.method === 'GET') {
    const ids = await redis.smembers(k('active_shares'));
    const shares = await getShares(ids);
    const byVideo = {};
    for (const s of shares) {
      if (!s.privateList || s.revoked || isExpired(s)) continue;
      (byVideo[s.videoId] ||= new Map());
      const existing = byVideo[s.videoId].get(s.email);
      if (!existing || s.expiresAt > existing.expiresAt) byVideo[s.videoId].set(s.email, s);
    }
    const result = {};
    for (const [videoId, byEmail] of Object.entries(byVideo)) {
      result[videoId] = [...byEmail.values()]
        .map((s) => ({ email: s.email, shareId: s.shareId, createdAt: s.createdAt, expiresAt: s.expiresAt }))
        .sort((a, b) => a.email.localeCompare(b.email));
    }
    return res.json(result);
  }

  const body = req.body || {};

  if (req.method === 'POST') {
    if (!(await allow(callerId(req, session, 'share')))) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }

    const videoId = body.videoId;
    const title = body.title || '';
    const notify = body.notify !== false; // on by default, matching Drive/YouTube's own sharing dialogs
    const emails = [...new Set(
      (Array.isArray(body.emails) ? body.emails : [])
        .map((e) => (e || '').toLowerCase().trim())
        .filter(Boolean)
    )];
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });
    if (!emails.length) return res.status(400).json({ error: 'At least one recipient email is required' });

    const existingEmails = new Set(
      (await listActiveSharesForVideo(videoId)).filter((s) => s.privateList).map((s) => s.email)
    );
    const newEmails = emails.filter((e) => !existingEmails.has(e));

    if (!newEmails.length) {
      return res.json({ added: [], alreadyListed: emails, emailedTo: [], mailEnabled: mailEnabled() });
    }

    const baseUrl = process.env.AUTH0_BASE_URL;
    const expiresAt = Date.now() + MAX_HOURS * 3600 * 1000;
    const newShares = newEmails.map((email) => ({
      shareId: crypto.randomUUID(),
      data: {
        videoId,
        title,
        email,
        expiresAt,
        createdAt: Date.now(),
        batchId: crypto.randomUUID(),
        privateList: true, // tags this share as owned by the list, not Create Link/Bulk Share
        views: 0,
        lastViewedAt: null,
        plays: 0,
        lastPlayAt: null,
        furthestPct: 0,
        completed: false,
        completedAt: null,
      },
    }));

    await saveShares(newShares);
    await redis.sadd(k('active_shares'), ...newShares.map((s) => s.shareId));
    await logAudit(actor, 'privatelist.add', `${newEmails.length} recipient(s) → ${title || videoId}`);

    // Bookkeeping runs regardless of `notify` — same "same email, same
    // place" bundling every other share flow gets.
    const bundleByRecipient = await syncBundlesForEmails(newEmails);

    const emailedTo = [];
    if (notify && mailEnabled()) {
      for (const share of newShares) {
        const recipient = share.data.email;
        const watchUrl = `${baseUrl}/watch/${share.shareId}`;
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
            expiresInHours: MAX_HOURS,
          });
        } else {
          ok = await sendShareLinksEmail({
            to: recipient,
            items: [{ title, watchUrl }],
            expiresInHours: MAX_HOURS,
          });
        }
        if (ok) {
          emailedTo.push(recipient);
          await logAudit(actor, 'share.email', `1 link(s) → ${recipient}`);
        }
      }
    }

    return res.json({
      added: newEmails,
      alreadyListed: emails.filter((e) => existingEmails.has(e)),
      emailedTo,
      mailEnabled: mailEnabled(),
    });
  }

  if (req.method === 'DELETE') {
    const videoId = body.videoId;
    const email = (body.email || '').toLowerCase().trim();
    if (!videoId || !email) return res.status(400).json({ error: 'videoId and email are required' });

    const toRevoke = (await listActiveSharesForVideo(videoId)).filter(
      (s) => s.email === email && s.privateList
    );
    if (!toRevoke.length) return res.status(404).json({ error: "That email is not on this video's list." });

    await saveShares(toRevoke.map((s) => ({ shareId: s.shareId, data: { ...s, revoked: true, revokedAt: Date.now() } })));
    await logAudit(actor, 'privatelist.remove', `${email} ← video ${videoId}`);
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
