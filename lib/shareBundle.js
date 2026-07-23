import crypto from 'crypto';
import { redis, k } from './redis';

// Bundles group a recipient's active share links into one listing page so
// they don't have to juggle several emails. A bundle is a PURE grouping
// record — just an email, a list of member shareIds, and the bundle's own
// expiry (needed to set the bundle key's own TTL). It never caches a member's
// title, view count, or status; every reader re-fetches each `share:{id}`
// record live, so revoking or expiring one item is reflected instantly
// without touching the bundle record.
//
// Grace-period TTL: previously a share's Redis TTL *was* its expiry, so an
// expired link's key vanished from Redis at the same moment it logically
// expired, making "expired" indistinguishable from "revoked" once passed.
// That breaks "extend a lapsed-but-not-revoked link", which needs the record
// to still exist after expiresAt. So the Redis TTL is now the logical expiry
// PLUS a grace window — `expiresAt` (an application-level field) is the only
// thing that determines "expired" for viewer access and display; the Redis
// key itself just needs to outlive that by enough margin for an admin to
// notice and extend it.
//
// Revoke is a SOFT delete: it sets `revoked: true` on the record rather than
// removing it, so an admin can un-revoke later without minting a new
// shareId/token. A revoked share stays a member of `active_shares` (that set
// now means "not yet reaped", not "currently usable") but is treated as
// unusable everywhere access or bundling is decided — watch pages, bundle
// membership, and bundle-candidate selection all check `!share.revoked` in
// addition to `!isExpired(share)`. Un-revoking just clears the flag; nothing
// else about the record (expiry, bundleId) changes.
export const GRACE_SECONDS = 30 * 24 * 3600; // 30 days past logical expiry before Redis reaps it

export function ttlSecondsFor(expiresAt) {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)) + GRACE_SECONDS;
}

export function isExpired(share) {
  return !share || typeof share.expiresAt !== 'number' || share.expiresAt <= Date.now();
}

export async function getShare(shareId) {
  return redis.get(k(`share:${shareId}`));
}

export async function saveShare(shareId, data) {
  await redis.set(k(`share:${shareId}`), data, { ex: ttlSecondsFor(data.expiresAt) });
}

// Batch fetch: one MGET instead of one GET per id. Any id whose record is
// gone (past its grace-period TTL) is dropped from the result and reaped
// from `active_shares` in one batched SREM, same cleanup the old per-id loop
// did, just no longer one round trip per stale id either.
export async function getShares(ids) {
  if (!ids.length) return [];
  const values = await redis.mget(...ids.map((id) => k(`share:${id}`)));
  const shares = [];
  const stale = [];
  ids.forEach((id, i) => {
    const data = values[i];
    if (!data) stale.push(id);
    else shares.push({ shareId: id, ...data });
  });
  if (stale.length) await redis.srem(k('active_shares'), ...stale);
  return shares;
}

export async function getBundle(bundleId) {
  if (!bundleId) return null;
  return redis.get(k(`bundle:${bundleId}`));
}

async function saveBundle(bundleId, bundle) {
  const ttl = ttlSecondsFor(bundle.expiresAt);
  await redis.set(k(`bundle:${bundleId}`), bundle, { ex: ttl });
  await redis.set(k(`bundle_by_email:${bundle.email}`), bundleId, { ex: ttl });
}

// All non-revoked shares currently addressed to this email (live lookup —
// scans the active_shares set, same pattern the admin shares list uses).
export async function listActiveSharesForEmail(email) {
  const ids = await redis.smembers(k('active_shares'));
  const shares = await getShares(ids);
  return shares.filter((s) => s.email === email && !s.revoked);
}

// Call after creating/touching shares for a recipient. Looks up (or forms)
// their one active bundle: "same email, same place" — never a second bundle
// per email while one is already active.
//
// - If a bundle already exists, sweep in any active-but-unbundled items for
//   this email (covers new links just created, and pre-existing links from
//   before bundling existed) and extend the bundle's expiry to match.
// - If no bundle exists yet, only form one once the recipient has 2+ active,
//   unbundled links total — a single link stays a plain link, no bundle.
export async function syncBundleForEmail(email) {
  const pointerKey = k(`bundle_by_email:${email}`);
  let bundleId = await redis.get(pointerKey);
  let bundle = bundleId ? await getBundle(bundleId) : null;
  if (bundleId && !bundle) bundleId = null; // pointer outlived the bundle record somehow

  const candidates = (await listActiveSharesForEmail(email)).filter(
    (s) => !s.bundleId && !isExpired(s)
  );

  if (bundle) {
    if (candidates.length > 0) {
      const newIds = candidates.map((c) => c.shareId);
      for (const c of candidates) {
        await saveShare(c.shareId, { ...c, bundleId });
      }
      bundle.itemIds = [...new Set([...bundle.itemIds, ...newIds])];
      bundle.expiresAt = Math.max(bundle.expiresAt, ...candidates.map((c) => c.expiresAt));
      await saveBundle(bundleId, bundle);
    }
    return { bundleId, isNew: false, memberIds: bundle.itemIds };
  }

  if (candidates.length >= 2) {
    bundleId = crypto.randomUUID();
    const itemIds = candidates.map((c) => c.shareId);
    const expiresAt = Math.max(...candidates.map((c) => c.expiresAt));
    for (const c of candidates) {
      await saveShare(c.shareId, { ...c, bundleId });
    }
    const newBundle = { email, itemIds, createdAt: Date.now(), expiresAt };
    await saveBundle(bundleId, newBundle);
    return { bundleId, isNew: true, memberIds: itemIds };
  }

  return { bundleId: null, isNew: false, memberIds: candidates.map((c) => c.shareId) };
}

// Extend a single share's expiry in place — same token/URL, no new link.
// Refuses a revoked (i.e. already-gone) item automatically, since revoke
// deletes the record outright. An already-expired-but-not-revoked item
// extends from now, not from its stale old expiry; a still-active item
// extends further out from its current expiry.
export async function extendShare(shareId, addHours) {
  const share = await getShare(shareId);
  if (!share) return { ok: false, error: 'Link has expired or does not exist.' };

  const base = share.expiresAt > Date.now() ? share.expiresAt : Date.now();
  const expiresAt = base + Math.max(1, Number(addHours) || 0) * 3600 * 1000;
  const updated = { ...share, expiresAt };
  await saveShare(shareId, updated);

  if (share.bundleId) {
    const bundle = await getBundle(share.bundleId);
    if (bundle && expiresAt > bundle.expiresAt) {
      bundle.expiresAt = expiresAt;
      await saveBundle(share.bundleId, bundle);
    }
  }

  return { ok: true, expiresAt };
}
