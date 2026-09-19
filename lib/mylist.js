// 'My list' — a per-viewer saved queue.
//
// Distinct from continue-watching (lib/store.js's progress hash), and the two
// must not be conflated: continue-watching is what you STARTED and is derived
// automatically from playback, while this is what you CHOSE and is only ever
// written by an explicit click. A video you saved but never opened belongs
// here and nowhere else; a video you watched halfway and never saved belongs
// there and nowhere else.
//
// PURE MODULE — no Redis import, deliberately, for the same reason
// lib/videoMeta.js and lib/captions.js are pure: the watch page and homepage
// both render list state in the browser, so anything this imports lands in
// the client bundle, and pulling lib/redis.js in here would drag Node
// built-ins (async_hooks, via lib/monitor.js) into that bundle and fail the
// build. Storage lives in lib/mylistStore.js — the same pure/store split this repo
// uses for lib/videoMeta.js vs lib/videoMetaStore.js.

// A saved list is a convenience, not an archive. The cap exists so one
// viewer's list can never become an unbounded Redis value, and it is generous
// enough that no real person will meet it.
export const MAX_ITEMS = 200;

// Stored as videoId -> when it was saved (epoch ms). A hash rather than a set
// because the list is shown newest-first, and a hash carries the ordering key
// with the membership. This repo uses no sorted sets anywhere, so a zset
// would be a new primitive for no gain here.
function toTime(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Redis hands back strings; a row written by an older version, or by hand,
// must not break the page. Anything unparseable sorts last rather than
// vanishing — the viewer saved it, so losing it is worse than misordering it.
export function normalizeList(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .filter(([videoId]) => typeof videoId === 'string' && videoId.trim())
    .map(([videoId, savedAt]) => ({ videoId: videoId.trim(), savedAt: toTime(savedAt) }))
    .sort((a, b) => b.savedAt - a.savedAt || a.videoId.localeCompare(b.videoId))
    .slice(0, MAX_ITEMS);
}

// Just the ids, newest first — what a caller needs to intersect with a video
// library it already holds.
export function listIds(raw) {
  return normalizeList(raw).map((entry) => entry.videoId);
}

export function isSaved(raw, videoId) {
  const id = String(videoId || '').trim();
  if (!id) return false;
  return normalizeList(raw).some((entry) => entry.videoId === id);
}

export function listCount(raw) {
  return normalizeList(raw).length;
}

// True when saving one more would exceed the cap. Checked before the write so
// the viewer gets a clear refusal rather than a silent drop.
export function isFull(raw, videoId) {
  if (isSaved(raw, videoId)) return false; // re-saving an existing entry is free
  return listCount(raw) >= MAX_ITEMS;
}

// Decorates a video list with saved state, so the homepage can render the
// toggle without a second round trip. Mirrors how lib/videoList.js carries
// notes along for search.
export function markSaved(videos, raw) {
  if (!Array.isArray(videos)) return [];
  const saved = new Set(listIds(raw));
  return videos.map((video) => ({ ...video, saved: saved.has(video?.id) }));
}

// The saved videos, in saved order, drawn from a library the caller already
// holds. Ids with no matching video simply drop out: a list entry can outlive
// the video it names (deleted from bunny), and a stale entry must not put a
// hole in the row.
export function savedVideos(videos, raw) {
  if (!Array.isArray(videos)) return [];
  const byId = new Map(videos.filter((v) => v?.id).map((v) => [v.id, v]));
  return listIds(raw)
    .map((id) => byId.get(id))
    .filter(Boolean);
}
