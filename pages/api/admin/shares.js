import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareLinksEmail, sendBundleEmail } from '../../../lib/mail';
import { getShare, saveShare, getBundle, listActiveSharesForEmail, extendShare } from '../../../lib/shareBundle';

// Every mutating action here (resend, revoke, extend) accepts either a single
// `shareId` or a `shareIds` array. Bulk requests never fail the whole batch
// on one bad item — each id is processed independently and reported back
// with its own ok/error, and the single-id shape keeps its original
// response format for backward compatibility with existing callers.
function idsFrom(body) {
  return Array.isArray(body.shareIds) ? body.shareIds : body.shareId ? [body.shareId] : [];
}

async function resendOne(shareId, actor) {
  const share = await redis.get(k(`share:${shareId}`));
  if (!share) return { shareId, ok: false, error: 'Link has expired or does not exist.' };

  const baseUrl = process.env.AUTH0_BASE_URL;
  let ok;

  // A bundled link is resent as the recipient's current consolidated bundle
  // email (live-read, not whatever was true when the bundle formed).
  if (share.bundleId) {
    const bundle = await getBundle(share.bundleId);
    if (bundle) {
      const allItems = await listActiveSharesForEmail(share.email);
      const items = allItems
        .filter((s) => bundle.itemIds.includes(s.shareId))
        .map((s) => ({ title: s.title, watchUrl: `${baseUrl}/watch/${s.shareId}` }));
      const hoursLeft = Math.max(1, Math.round((bundle.expiresAt - Date.now()) / 3600000));
      ok = await sendBundleEmail({
        to: share.email,
        bundleUrl: `${baseUrl}/watch/bundle/${share.bundleId}`,
        items,
        expiresInHours: hoursLeft,
      });
    }
  }

  if (ok === undefined) {
    const watchUrl = `${baseUrl}/watch/${shareId}`;
    const hoursLeft = Math.max(1, Math.round((share.expiresAt - Date.now()) / 3600000));
    ok = await sendShareLinksEmail({
      to: share.email,
      items: [{ title: share.title, watchUrl }],
      expiresInHours: hoursLeft,
    });
  }

  if (ok) await logAudit(actor, 'share.resend', `${share.title || share.videoId} → ${share.email}`);
  return { shareId, ok: Boolean(ok), error: ok ? undefined : 'Email failed to send.' };
}

// Soft delete: flip `revoked` on the record rather than deleting it, so an
// admin can un-revoke later without minting a new shareId/token. The record
// stays in `active_shares` (that set means "not yet reaped", not "usable")
// but every access/bundling check treats a revoked share as unusable.
async function revokeOne(shareId, actor) {
  const share = await getShare(shareId);
  if (!share) return { shareId, ok: false, error: 'Link has expired or does not exist.' };
  if (!share.revoked) {
    await saveShare(shareId, { ...share, revoked: true, revokedAt: Date.now() });
    await logAudit(actor, 'share.revoke', shareId);
  }
  return { shareId, ok: true };
}

// Restores a revoked-but-not-deleted share in place — same shareId/token,
// no re-share, no re-notification. A no-op (still ok:true) if it wasn't
// revoked to begin with; refuses only if the record is genuinely gone.
async function unrevokeOne(shareId, actor) {
  const share = await getShare(shareId);
  if (!share) return { shareId, ok: false, error: 'Link has expired or does not exist.' };
  if (share.revoked) {
    await saveShare(shareId, { ...share, revoked: false, revokedAt: null });
    await logAudit(actor, 'share.unrevoke', shareId);
  }
  return { shareId, ok: true };
}

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
        // Already reaped by Redis (well past its grace period) — clean up the stale reference.
        await redis.srem(k('active_shares'), id);
        continue;
      }
      shares.push({ shareId: id, ...data });
    }

    shares.sort((a, b) => a.expiresAt - b.expiresAt);
    return res.json(shares);
  }

  const body = req.body || {};
  const ids = idsFrom(body);

  // Resend the email for one or more active links to their original recipients.
  if (req.method === 'POST') {
    if (!(await allow(callerId(req, session, 'share')))) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    if (!mailEnabled()) return res.status(503).json({ error: 'Email is not configured.' });
    if (!ids.length) return res.status(400).json({ error: 'shareId(s) required' });

    const results = [];
    for (const id of ids) results.push(await resendOne(id, actor));

    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) {
        const status = r.error === 'Link has expired or does not exist.' ? 404 : 502;
        return res.status(status).json({ error: r.error });
      }
      return res.json({ emailed: true });
    }
    return res.json({ results });
  }

  if (req.method === 'DELETE') {
    if (!ids.length) return res.status(400).json({ error: 'shareId(s) required' });
    const results = [];
    for (const id of ids) results.push(await revokeOne(id, actor));
    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(404).json({ error: r.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  // Un-revoke: restore one or more revoked-but-not-deleted links in place.
  if (req.method === 'PATCH') {
    if (!ids.length) return res.status(400).json({ error: 'shareId(s) required' });
    const results = [];
    for (const id of ids) results.push(await unrevokeOne(id, actor));
    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(404).json({ error: r.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  // Extend a link's (or several links') expiry in place — same token/URL, no
  // re-notification needed. Works on an already-expired-but-not-revoked link
  // (extends from now); refuses a revoked one automatically, since revoke
  // deletes the record and extendShare() treats a missing record as an error.
  if (req.method === 'PUT') {
    if (!(await allow(callerId(req, session, 'share')))) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    const addHours = Math.min(Number(body.addHours) || 0, 720);
    if (!ids.length || addHours <= 0) {
      return res.status(400).json({ error: 'shareId(s) and a positive addHours are required' });
    }

    const results = [];
    for (const id of ids) {
      const r = await extendShare(id, addHours);
      if (r.ok) await logAudit(actor, 'share.extend', `${id} +${addHours}h`);
      results.push({ shareId: id, ...r });
    }

    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(404).json({ error: r.error });
      return res.json({ ok: true, expiresAt: r.expiresAt });
    }
    return res.json({ results });
  }

  res.status(405).end();
}
