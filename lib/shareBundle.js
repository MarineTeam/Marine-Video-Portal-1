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

// Batch save: pipelines N SETs into a single round trip instead of N
// sequential ones. Still N commands server-side (each share has its own
// value and TTL, so there's no MSET-with-per-key-expiry to fall back to),
// but one round trip instead of N is the difference between a bulk action
// finishing promptly and one timing out partway through on a large batch.
export async function saveShares(items) {
  if (!items.length) return;
  const pipeline = redis.pipeline();
  for (const { shareId, data } of items) {
    pipeline.set(k(`share:${shareId}`), data, { ex: ttlSecondsFor(data.expiresAt) });
  }
  await pipeline.exec();
}

export async function getBundle(bundleId) {
  if (!bundleId) return null;
  return redis.get(k(`bundle:${bundleId}`));
}

// All non-revoked shares currently addressed to this email (live lookup —
// scans the active_shares set, same pattern the admin shares list uses).
export async function listActiveSharesForEmail(email) {
  const ids = await redis.smembers(k('active_shares'));
  const shares = await getShares(ids);
  return shares.filter((s) => s.email === email && !s.revoked);
}

// Batch version of the old per-recipient syncBundleForEmail. Call once with
// every recipient from a bulk share-creation request instead of once per
// recipient — the old per-recipient version called listActiveSharesForEmail
// (a full SMEMBERS + MGET of the ENTIRE active_shares set) once per
// recipient, so creating shares for N recipients scanned every active share
// in the whole system N times over in one request. This takes ONE snapshot
// of active_shares up front and reuses it for every recipient, then batches
// every resulting write (share bundleId stamps, bundle records, pointers)
// into pipelined round trips instead of one-at-a-time.
//
// Per recipient: looks up (or forms) their one active bundle — "same email,
// same place", never a second bundle per email while one is already active.
// - If a bundle already exists, sweep in any active-but-unbundled items for
//   this email and extend the bundle's expiry to match.
// - If no bundle exists yet, only form one once the recipient has 2+ active,
//   unbundled links total — a single link stays a plain link, no bundle.
//
// Returns a Map<email, { bundleId, isNew, memberIds }>, same shape the old
// function returned per call.
export async function syncBundlesForEmails(emails) {
  const uniqueEmails = [...new Set(emails)];
  const results = new Map();
  if (!uniqueEmails.length) return results;

  const ids = await redis.smembers(k('active_shares'));
  const allShares = await getShares(ids); // one snapshot, reused for every recipient below

  const sharesByEmail = new Map(uniqueEmails.map((e) => [e, []]));
  for (const share of allShares) {
    if (!share.revoked && sharesByEmail.has(share.email)) sharesByEmail.get(share.email).push(share);
  }

  const pointerValues = await redis.mget(...uniqueEmails.map((e) => k(`bundle_by_email:${e}`)));
  const bundleIdByEmail = new Map();
  uniqueEmails.forEach((email, i) => {
    if (pointerValues[i]) bundleIdByEmail.set(email, pointerValues[i]);
  });

  const existingBundleIds = [...new Set(bundleIdByEmail.values())];
  const existingBundleValues = existingBundleIds.length
    ? await redis.mget(...existingBundleIds.map((id) => k(`bundle:${id}`)))
    : [];
  const bundleById = new Map();
  existingBundleIds.forEach((id, i) => {
    if (existingBundleValues[i]) bundleById.set(id, existingBundleValues[i]);
  });

  const shareUpdates = []; // shares to stamp with a bundleId
  const bundleWrites = []; // { bundleId, bundle } to persist

  for (const email of uniqueEmails) {
    const candidates = sharesByEmail.get(email).filter((s) => !s.bundleId && !isExpired(s));
    let bundleId = bundleIdByEmail.get(email) || null;
    let bundle = bundleId ? bundleById.get(bundleId) : null;
    if (bundleId && !bundle) bundleId = null; // pointer outlived the bundle record somehow

    if (bundle) {
      if (candidates.length > 0) {
        const newIds = candidates.map((c) => c.shareId);
        for (const c of candidates) shareUpdates.push({ shareId: c.shareId, data: { ...c, bundleId } });
        bundle = {
          ...bundle,
          itemIds: [...new Set([...bundle.itemIds, ...newIds])],
          expiresAt: Math.max(bundle.expiresAt, ...candidates.map((c) => c.expiresAt)),
        };
        bundleWrites.push({ bundleId, bundle });
      }
      results.set(email, { bundleId, isNew: false, memberIds: bundle.itemIds });
      continue;
    }

    if (candidates.length >= 2) {
      bundleId = crypto.randomUUID();
      const itemIds = candidates.map((c) => c.shareId);
      const expiresAt = Math.max(...candidates.map((c) => c.expiresAt));
      for (const c of candidates) shareUpdates.push({ shareId: c.shareId, data: { ...c, bundleId } });
      const newBundle = { email, itemIds, createdAt: Date.now(), expiresAt };
      bundleWrites.push({ bundleId, bundle: newBundle });
      results.set(email, { bundleId, isNew: true, memberIds: itemIds });
      continue;
    }

    results.set(email, { bundleId: null, isNew: false, memberIds: candidates.map((c) => c.shareId) });
  }

  if (shareUpdates.length) await saveShares(shareUpdates);

  if (bundleWrites.length) {
    const pipeline = redis.pipeline();
    for (const { bundleId, bundle } of bundleWrites) {
      const ttl = ttlSecondsFor(bundle.expiresAt);
      pipeline.set(k(`bundle:${bundleId}`), bundle, { ex: ttl });
      pipeline.set(k(`bundle_by_email:${bundle.email}`), bundleId, { ex: ttl });
    }
    await pipeline.exec();
  }

  return results;
}

// Extend one or more shares' expiry in place — same token/URL, no new link.
// A missing record (permanently deleted) is refused; an already-expired-
// but-not-revoked item extends from now, a still-active one extends further
// out from its current expiry. One MGET for the batch, one pipelined batch
// of SETs, and bundle-expiry sync deduped per bundle (several shares in a
// batch can belong to the same bundle) rather than a bundle round trip per
// share — O(shares) + O(distinct bundles) commands instead of O(shares) × 4.
export async function extendShares(ids, addHours) {
  const shares = await getShares(ids);
  const shareMap = new Map(shares.map((s) => [s.shareId, s]));
  const results = [];
  const toSave = [];

  for (const id of ids) {
    const share = shareMap.get(id);
    if (!share) {
      results.push({ shareId: id, ok: false, error: 'Link has expired or does not exist.' });
      continue;
    }
    const base = share.expiresAt > Date.now() ? share.expiresAt : Date.now();
    const expiresAt = base + Math.max(1, Number(addHours) || 0) * 3600 * 1000;
    toSave.push({ shareId: id, data: { ...share, expiresAt } });
    results.push({ shareId: id, ok: true, expiresAt });
  }

  if (!toSave.length) return results;
  await saveShares(toSave);

  const bundleBumps = new Map(); // bundleId -> furthest new expiresAt among its extended members
  for (const { data } of toSave) {
    if (!data.bundleId) continue;
    if (data.expiresAt > (bundleBumps.get(data.bundleId) || 0)) bundleBumps.set(data.bundleId, data.expiresAt);
  }
  if (bundleBumps.size) {
    const bundleIds = [...bundleBumps.keys()];
    const bundleValues = await redis.mget(...bundleIds.map((id) => k(`bundle:${id}`)));
    const pipeline = redis.pipeline();
    let any = false;
    bundleIds.forEach((bundleId, i) => {
      const bundle = bundleValues[i];
      const newExpiry = bundleBumps.get(bundleId);
      if (bundle && newExpiry > bundle.expiresAt) {
        bundle.expiresAt = newExpiry;
        const ttl = ttlSecondsFor(bundle.expiresAt);
        pipeline.set(k(`bundle:${bundleId}`), bundle, { ex: ttl });
        pipeline.set(k(`bundle_by_email:${bundle.email}`), bundleId, { ex: ttl });
        any = true;
      }
    });
    if (any) await pipeline.exec();
  }

  return results;
}

// Strip permanently-deleted shares out of any bundle they belonged to. Hard
// delete is irreversible, so an un-pruned itemIds entry would sit dead in
// the bundle forever otherwise (bounded only by the bundle's own TTL, which
// can keep getting pushed out by unrelated members being extended). Revoke/
// un-revoke deliberately leave bundle membership alone — see the comment on
// the DELETE handler in pages/api/admin/shares.js — since they're
// reversible and the bundle page already filters revoked members live
// (pages/watch/bundle/[bundleId].js). Commands scale with the number of
// DISTINCT bundles touched, not the number of shares deleted.
export async function pruneFromBundles(deletedIds, shareMap) {
  const byBundle = new Map(); // bundleId -> Set of deleted shareIds that belonged to it
  for (const id of deletedIds) {
    const bundleId = shareMap.get(id)?.bundleId;
    if (!bundleId) continue;
    if (!byBundle.has(bundleId)) byBundle.set(bundleId, new Set());
    byBundle.get(bundleId).add(id);
  }
  if (!byBundle.size) return;

  const bundleIds = [...byBundle.keys()];
  const bundleValues = await redis.mget(...bundleIds.map((id) => k(`bundle:${id}`)));

  const toDeleteKeys = [];
  const toSave = [];
  const emptiedEmails = [];

  bundleIds.forEach((bundleId, i) => {
    const bundle = bundleValues[i];
    if (!bundle) return;
    const removed = byBundle.get(bundleId);
    const remaining = bundle.itemIds.filter((sid) => !removed.has(sid));
    if (remaining.length === bundle.itemIds.length) return;
    if (remaining.length === 0) {
      toDeleteKeys.push(k(`bundle:${bundleId}`));
      emptiedEmails.push({ bundleId, email: bundle.email });
    } else {
      toSave.push({ bundleId, bundle: { ...bundle, itemIds: remaining } });
    }
  });

  if (toDeleteKeys.length) await redis.del(...toDeleteKeys);

  if (toSave.length) {
    const pipeline = redis.pipeline();
    for (const { bundleId, bundle } of toSave) {
      pipeline.set(k(`bundle:${bundleId}`), bundle, { ex: ttlSecondsFor(bundle.expiresAt) });
    }
    await pipeline.exec();
  }

  if (emptiedEmails.length) {
    // Only clear a pointer if it still points at the bundle we just
    // deleted — guards against clobbering a newer bundle formed for the
    // same email in between.
    const pointerKeys = emptiedEmails.map(({ email }) => k(`bundle_by_email:${email}`));
    const pointerValues = await redis.mget(...pointerKeys);
    const staleKeys = pointerKeys.filter((key, i) => pointerValues[i] === emptiedEmails[i].bundleId);
    if (staleKeys.length) await redis.del(...staleKeys);
  }
}
