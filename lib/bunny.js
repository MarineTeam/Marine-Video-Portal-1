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

// Direct CDN URL for a video's MEDIA file, for podcast-feed enclosures.
//
// This is a NEW consumer of the SAME URL Token Authentication scheme
// getThumbnailUrl already uses — identical formula, identical encoding, just a
// different path. None of the three signing formulas above is modified.
//
// TWO THINGS MUST BE TRUE AT THE BUNNY END for the resulting URL to play in a
// podcast app, and neither can be verified from the codebase:
//
//   1. The rendition named by PODCAST_MEDIA_FILE must actually exist in the
//      library. Bunny generates renditions per library configuration; this app
//      has never referenced direct media files before, so nothing here knows
//      which ones are present. Default is play_480p.mp4.
//   2. The pull zone must accept a token-authenticated request that carries NO
//      Referer header. Bunny's hotlink protection is referrer-based, which is
//      why a signed thumbnail 403s when pasted into an address bar (see the
//      bunny-reference skill, section 5). A podcast app sends no Referer, so
//      it hits that same path. URL Token Authentication and referrer hotlink
//      protection are independent toggles — token auth alone is what makes
//      this work.
//
// Returns '' when BUNNY_CDN_HOSTNAME is unset, so the feed degrades to no
// enclosures rather than emitting broken URLs — the same posture
// getThumbnailUrl takes.
export function getVideoFileUrl(video, ttlSeconds = 86400) {
  const host = (process.env.BUNNY_CDN_HOSTNAME || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!host || !video || !video.guid) return '';

  const file = (process.env.PODCAST_MEDIA_FILE || 'play_480p.mp4').trim().replace(/^\/+/, '');
  if (!file) return '';
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

export function podcastMediaFile() {
  return (process.env.PODCAST_MEDIA_FILE || 'play_480p.mp4').trim();
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
// Queues bunny's Transcribe AI (Whisper). ASYNCHRONOUS — this returns once the
// job is queued, not when captions exist.
//
// THIS CALL COSTS MONEY: $0.10 per minute of video, per language. A 90-minute
// service is $9 from one POST, which is why the route in front of it is
// capability-gated and rate-limited.
//
// Everything bunny can generate BESIDES captions is explicitly off:
//
//   generateTitle/generateDescription — titles here are admin-authored; a
//     transcription job must never rename someone's library.
//   generateMoments                   — off for the same reason as titles:
//     nothing here reads moments, so generating them is output with no reader.
//
// `generateChapters` is the ONE exception, and it is opt-in. It writes to
// bunny's own video object, never to the video-meta hash — the hand-typed list
// this repo renders is untouched by a transcription job whatever this flag
// says. lib/aiChapters.js reads the result back and it lands in the admin's
// textarea, where a person accepts it through the ordinary save. Two writers
// for one concept is how hand-written chapters get silently replaced; this way
// the AI proposes and only a person accepts.
//
// `force` re-runs transcription on a video that already has it — a second
// charge for the same minutes — so it defaults to false and must be opted in.
export async function transcribeVideo(
  videoId,
  { sourceLanguage, force = false, generateChapters = false } = {}
) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  const query = force ? '?force=true' : '';
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}/transcribe${query}`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        ...(sourceLanguage ? { sourceLanguage } : {}),
        generateTitle: false,
        generateDescription: false,
        generateChapters: generateChapters === true,
        generateMoments: false,
      }),
    }
  );
  if (!res.ok) throw new Error(`Bunny transcribe error: ${res.status}`);
  return true;
}

// One video straight from Bunny, or null. Needed because the ingest step has
// to read `captions[]` — which languages Bunny actually produced — and
// listVideos() is capped at a page, so a large library could not answer it.
export async function getVideoById(videoId) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Bunny get-video error: ${res.status}`);
  return res.json();
}

// Fetches one caption track's WebVTT text, SERVER-SIDE ONLY.
//
// Caption files sit on the pull zone at /{guid}/captions/{srclang}.vtt. This
// returns the VTT *text*, never the URL, and no caller is given a way to get
// the URL — so the transcript inherits the video's access gate instead of
// being readable by anyone who learns a GUID. That matters because a
// transcript is the whole content of a private video in text form.
//
// The signed URL is deliberately short-lived: it only has to survive this
// server-side fetch, unlike a thumbnail a browser re-requests.
export async function fetchCaptionVtt(videoId, srclang) {
  if (typeof videoId !== 'string' || !GUID_RE.test(videoId)) {
    throw new Error('Invalid videoId');
  }
  const lang = String(srclang || '').trim();
  if (!/^[A-Za-z0-9-]{2,12}$/.test(lang)) return null;

  const host = (process.env.BUNNY_CDN_HOSTNAME || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!host) return null;

  const path = `/${videoId}/captions/${lang}.vtt`;
  const base = `https://${host}${path}`;
  const key = (process.env.BUNNY_CDN_TOKEN_KEY || process.env.BUNNY_TOKEN_AUTH_KEY || '').trim();

  let url = base;
  if (key) {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const token = crypto
      .createHash('sha256')
      .update(key + path + expires)
      .digest('base64')
      .replace(/\n/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    url = `${base}?token=${token}&expires=${expires}`;
  }

  const res = await fetch(url);
  // A 404 is the ordinary "not transcribed yet" answer, not a failure.
  if (!res.ok) return null;
  return res.text();
}
