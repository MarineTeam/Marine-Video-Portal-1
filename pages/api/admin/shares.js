import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { allow, callerId } from '../../../lib/ratelimit';
import { mailEnabled, sendShareLinksEmail, sendBundleEmail } from '../../../lib/mail';
import {
  getShares,
  saveShares,
  getBundle,
  listActiveSharesForEmail,
  extendShares,
  pruneFromBundles,
} from '../../../lib/shareBundle';
import { withMonitorApi } from '../../../lib/monitor';

// Every mutating action here (resend, revoke, extend) accepts either a single
// `shareId` or a `shareIds` array. Bulk requests never fail the whole batch
// on one bad item — each id is processed independently and reported back
// with its own ok/error, and the single-id shape keeps its original
// response format for backward compatibility with existing callers.
//
// Each batch function below does exactly one MGET to fetch every share in
// the request (via getShares), then a single audit log entry for the whole
// batch instead of one per item — with a couple hundred+ ids, one-entry-per-
// id was also blowing through the audit log's 200-entry cap in a single
// bulk action, wiping out unrelated history. Writes still need one Redis
// command per share that actually changes (each has its own TTL), but those
// are pipelined into one round trip via saveShares/redis.pipeline rather
// than one round trip per id.
function idsFrom(body) {
  return Array.isArray(body.shareIds) ? body.shareIds : body.shareId ? [body.shareId] : [];
}

async function resendMany(ids, actor) {
  const shareMap = new Map((await getShares(ids)).map((s) => [s.shareId, s]));
  const baseUrl = process.env.AUTH0_BASE_URL;
  const results = [];

  for (const shareId of ids) {
    const share = shareMap.get(shareId);
    if (!share) {
      results.push({ shareId, ok: false, error: 'Link has expired or does not exist.' });
      continue;
    }

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

    results.push({ shareId, ok: Boolean(ok), error: ok ? undefined : 'Email failed to send.' });
  }

  const sent = results.filter((r) => r.ok).length;
  if (sent) await logAudit(actor, 'share.resend', `${sent} link(s)`);
  return results;
}

// Soft delete: flip `revoked` on the record rather than deleting it, so an
// admin can un-revoke later without minting a new shareId/token. The record
// stays in `active_shares` (that set means "not yet reaped", not "usable")
// but every access/bundling check treats a revoked share as unusable.
async function revokeMany(ids, actor) {
  const shareMap = new Map((await getShares(ids)).map((s) => [s.shareId, s]));
  const results = [];
  const toSave = [];

  for (const shareId of ids) {
    const share = shareMap.get(shareId);
    if (!share) {
      results.push({ shareId, ok: false, error: 'Link has expired or does not exist.' });
      continue;
    }
    if (!share.revoked) toSave.push({ shareId, data: { ...share, revoked: true, revokedAt: Date.now() } });
    results.push({ shareId, ok: true });
  }

  if (toSave.length) {
    await saveShares(toSave);
    await logAudit(actor, 'share.revoke', `${toSave.length} link(s)`);
  }
  return results;
}

// Restores revoked-but-not-deleted shares in place — same shareId/token,
// no re-share, no re-notification. A no-op (still ok:true) for one that
// wasn't revoked to begin with; refuses only if the record is genuinely gone.
async function unrevokeMany(ids, actor) {
  const shareMap = new Map((await getShares(ids)).map((s) => [s.shareId, s]));
  const results = [];
  const toSave = [];

  for (const shareId of ids) {
    const share = shareMap.get(shareId);
    if (!share) {
      results.push({ shareId, ok: false, error: 'Link has expired or does not exist.' });
      continue;
    }
    if (share.revoked) toSave.push({ shareId, data: { ...share, revoked: false, revokedAt: null } });
    results.push({ shareId, ok: true });
  }

  if (toSave.length) {
    await saveShares(toSave);
    await logAudit(actor, 'share.unrevoke', `${toSave.length} link(s)`);
  }
  return results;
}

// Actually removes the record — the un-revokable option is gone for good
// after this. Only allowed on shares that are already (soft-)revoked, so
// permanent deletion is always a deliberate second step after revoke, never
// a way to skip straight past it on a link that's still live. DEL and SREM
// both take multiple keys/members in one command, so this is O(1) Redis
// commands regardless of how many ids are in the batch.
async function hardDeleteMany(ids, actor) {
  const shareMap = new Map((await getShares(ids)).map((s) => [s.shareId, s]));
  const results = [];
  const eligible = [];

  for (const shareId of ids) {
    const share = shareMap.get(shareId);
    if (!share) {
      results.push({ shareId, ok: false, error: 'Link has expired or does not exist.' });
      continue;
    }
    if (!share.revoked) {
      results.push({ shareId, ok: false, error: 'Revoke the link before deleting it permanently.' });
      continue;
    }
    eligible.push(shareId);
    results.push({ shareId, ok: true });
  }

  if (eligible.length) {
    await redis.del(...eligible.map((id) => k(`share:${id}`)));
    await redis.srem(k('active_shares'), ...eligible);
    await pruneFromBundles(eligible, shareMap);
    await logAudit(actor, 'share.delete', `${eligible.length} link(s)`);
  }
  return results;
}

async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const ids = await redis.smembers(k('active_shares'));
    const shares = await getShares(ids);
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

    const results = await resendMany(ids, actor);

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

  // Revoke (soft) by default; `permanent: true` hard-deletes instead — only
  // honored on shares that are already revoked (see hardDeleteMany).
  if (req.method === 'DELETE') {
    if (!ids.length) return res.status(400).json({ error: 'shareId(s) required' });
    const permanent = Boolean(body.permanent);
    const results = await (permanent ? hardDeleteMany(ids, actor) : revokeMany(ids, actor));
    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(r.error === 'Link has expired or does not exist.' ? 404 : 400).json({ error: r.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  // Un-revoke: restore one or more revoked-but-not-deleted links in place.
  if (req.method === 'PATCH') {
    if (!ids.length) return res.status(400).json({ error: 'shareId(s) required' });
    const results = await unrevokeMany(ids, actor);
    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(404).json({ error: r.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  // Extend a link's (or several links') expiry in place — same token/URL, no
  // re-notification needed. Works on an already-expired-but-not-revoked link
  // (extends from now); extendShares() only refuses a share that's been
  // permanently deleted (missing record) — a merely-revoked one still has
  // its expiry pushed out, so it resumes wherever it left off if un-revoked.
  if (req.method === 'PUT') {
    if (!(await allow(callerId(req, session, 'share')))) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    const addHours = Math.min(Number(body.addHours) || 0, 720);
    if (!ids.length || addHours <= 0) {
      return res.status(400).json({ error: 'shareId(s) and a positive addHours are required' });
    }

    const results = await extendShares(ids, addHours);
    const okCount = results.filter((r) => r.ok).length;
    if (okCount) await logAudit(actor, 'share.extend', `${okCount} link(s) +${addHours}h`);

    if (ids.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(404).json({ error: r.error });
      return res.json({ ok: true, expiresAt: r.expiresAt });
    }
    return res.json({ results });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
