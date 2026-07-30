import crypto from 'crypto';
import { recordExternal } from './monitor';

const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';

// Query Monitor instrumentation for outbound Bunny calls.
//
// This module-scoped `fetch` deliberately SHADOWS the global inside this file,
// so all the `await fetch(...)` call sites below are timed without any of them
// being edited. That is the point: the signing formulas and the inline GUID
// validation in this file are byte-frozen vendor/security contracts, and the
// cheapest way to respect that is to not touch those lines at all. Behaviour is
// otherwise identical — same arguments, same return value, errors propagate
// untouched, and recordExternal is a no-op when the monitor is off.
const globalFetch = globalThis.fetch;

function bunnyLabel(input) {
  try {
    const url = typeof input === 'string' ? input : input?.url || '';
    const { pathname } = new URL(url);
    // /library/<id>/videos/<guid> -> bunny /videos, keeping ids out of the label
    const parts = pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'videos' || p === 'collections' || p === 'statistics');
    return `bunny /${idx >= 0 ? parts[idx] : 'api'}`;
  } catch (e) {
    return 'bunny /api';
  }
}

async function fetch(...args) {
  const start = process.hrtime.bigint();
  try {
    return await globalFetch(...args);
  } finally {
    recordExternal(bunnyLabel(args[0]), Number(process.hrtime.bigint() - start) / 1e6);
  }
}

// Bunny video/collection ids are standard UUIDs. Validating them before they're
// interpolated into a request URL closes the "unvalidated path segment in an
// outbound request" pattern flagged as SSRF, and rejects garbage before it
// ever reaches Bunny's API.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listVideos({ itemsPerPage = 100 } = {}) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos?page=1&itemsPerPage=${itemsPerPage}&orderBy=date`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY } }
  );
  if (!res.ok) throw new Error(`Bunny API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// Create an empty video object in the library; the bytes are uploaded separately
// (via TUS) by the browser. Returns the new video's guid.
export async function createVideo(title) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ title }),
    }
  );
  if (!res.ok) throw new Error(`Bunny create-video error: ${res.status}`);
  const data = await res.json();
  return data.guid;
}

// Sign a TUS upload so the browser can stream the file straight to Bunny without
// ever seeing the library API key. Signature = SHA256(libraryId + apiKey + expires + videoId).
export function signTusUpload(videoId, expiresInSeconds = 86400) {
  // Trim env values: a stray newline/space is silently dropped from the AccessKey
  // header (so createVideo still works) but corrupts the SHA256 signature → HTTP 401.
  const libraryId = (process.env.BUNNY_LIBRARY_ID || '').trim();
  const apiKey = (process.env.BUNNY_API_KEY || '').trim();
  // Bunny TUS expects the expiry as a Unix timestamp in SECONDS.
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const signature = crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${expires}${videoId}`)
    .digest('hex');
  return { libraryId, signature, expires };
}

export async function updateVideoTitle(videoId, title) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ title }),
    }
  );
  if (!res.ok) throw new Error(`Bunny update-video error: ${res.status}`);
  return true;
}

export async function deleteVideo(videoId) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
    { method: 'DELETE', headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bunny delete-video error: ${res.status}`);
  return true;
}

export async function listCollections() {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/collections?page=1&itemsPerPage=100&orderBy=name`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bunny list-collections error: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((c) => ({ id: c.guid, name: c.name, videoCount: c.videoCount }));
}

export async function createCollection(name) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/collections`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ name }),
    }
  );
  if (!res.ok) throw new Error(`Bunny create-collection error: ${res.status}`);
  const data = await res.json();
  return { id: data.guid, name: data.name };
}

export async function deleteCollection(collectionId) {
  if (typeof collectionId !== 'string' || !GUID_RE.test(collectionId)) {
    throw new Error('Invalid collectionId');
  }
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/collections/${collectionId}`,
    { method: 'DELETE', headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bunny delete-collection error: ${res.status}`);
  return true;
}

export async function setVideoCollection(videoId, collectionId) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  if (collectionId && !GUID_RE.test(collectionId)) {
    throw new Error('Invalid collectionId');
  }
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ collectionId: collectionId || '' }),
    }
  );
  if (!res.ok) throw new Error(`Bunny set-collection error: ${res.status}`);
  return true;
}

// Direct CDN URL for a video's thumbnail. Needs the library's CDN hostname
// (BUNNY_CDN_HOSTNAME, e.g. "vz-xxxx.b-cdn.net"). Returns '' if not configured
// so the UI can fall back gracefully.
//
// If a CDN token key is available (BUNNY_CDN_TOKEN_KEY, falling back to
// BUNNY_TOKEN_AUTH_KEY) the path is signed with Bunny's URL Token
// Authentication so thumbnails still load when "Block Direct URL File Access"
// is enabled. Signing is harmless when token auth is off (the params are
// ignored), so we always sign when a key is present.
export function getThumbnailUrl(video, ttlSeconds = 86400) {
  const host = (process.env.BUNNY_CDN_HOSTNAME || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!host || !video || !video.guid) return '';

  const file = video.thumbnailFileName || 'thumbnail.jpg';
  const path = `/${video.guid}/${file}`;
  const base = `https://${host}${path}`;

  const key = (process.env.BUNNY_CDN_TOKEN_KEY || process.env.BUNNY_TOKEN_AUTH_KEY || '').trim();
  if (!key) return base;

  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = crypto
    .createHash('sha256')
    .update(key + path + expires)
    .digest('base64')
    .replace(/\n/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${base}?token=${token}&expires=${expires}`;
}

export async function getLibraryStatistics({ dateFrom, dateTo } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/statistics?${params.toString()}`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bunny statistics error: ${res.status}`);
  return res.json();
}

export function signVideoToken(videoId, expiresInSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const hashable = `${process.env.BUNNY_TOKEN_AUTH_KEY}${videoId}${expires}`;
  const token = crypto.createHash('sha256').update(hashable).digest('hex');
  return { token, expires };
}

export function getEmbedUrl(videoId, expiresInSeconds = 3600) {
  const { token, expires } = signVideoToken(videoId, expiresInSeconds);
  return `https://iframe.mediadelivery.net/embed/${process.env.BUNNY_LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}&autoplay=false`;
}