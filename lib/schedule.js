import { redis, k } from './redis';

// Scheduled publish / expiry per video.
//
// A schedule is OPTIONAL and ADDITIVE, in the same spirit as the per-video
// watermark override: a video with no schedule entry behaves exactly as it
// always has (visible to every approved viewer whose groups allow it). Only a
// video an admin has deliberately scheduled is ever hidden by this. That
// matters for the same reason the group opt-in rule does — a default that
// hides things on deploy looks exactly like an outage.
//
// Both bounds are independently optional:
//   publishAt set, expiresAt null -> hidden until publishAt, then forever visible
//   publishAt null, expiresAt set -> visible until expiresAt, then hidden
//   both set                      -> visible only inside the window
//   neither set                   -> no entry stored at all (see setSchedule)
//
// Staff bypass this entirely: an admin curating next week's release has to be
// able to see, play and check the video before it goes live. The admin UI
// badges those rows so "scheduled" never looks like "broken".

const KEY = 'video_schedule';

export const STATE_LIVE = 'live';
export const STATE_SCHEDULED = 'scheduled'; // not published yet
export const STATE_EXPIRED = 'expired';
export const STATE_NONE = 'none'; // no schedule set

// Accepts a ms epoch number, a numeric string, or an ISO/datetime-local
// string (what <input type="datetime-local"> submits). Returns null for
// anything unusable rather than NaN, so a bad value degrades to "no bound"
// instead of hiding a video forever.
export function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseEntry(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const publishAt = toTimestamp(obj.publishAt);
    const expiresAt = toTimestamp(obj.expiresAt);
    if (publishAt === null && expiresAt === null) return null;
    return { publishAt, expiresAt };
  } catch {
    return null;
  }
}

// --- Pure helpers (no Redis; unit-tested in lib/__tests__/schedule.test.js) ---

export function scheduleState(entry, now = Date.now()) {
  if (!entry || (entry.publishAt === null && entry.expiresAt === null)) return STATE_NONE;
  if (entry.publishAt !== null && now < entry.publishAt) return STATE_SCHEDULED;
  if (entry.expiresAt !== null && now >= entry.expiresAt) return STATE_EXPIRED;
  return STATE_LIVE;
}

export function isVisibleNow(entry, now = Date.now()) {
  const state = scheduleState(entry, now);
  return state === STATE_NONE || state === STATE_LIVE;
}

// `schedules` is a map of videoId -> entry (or null). Videos with no entry
// pass through untouched.
export function filterScheduled(schedules, videos, now = Date.now()) {
  if (!schedules) return videos || [];
  return (videos || []).filter((v) => isVisibleNow(schedules[v.guid], now));
}

// A window where the video is never visible is almost always a typo (dates
// entered the wrong way round), and it would silently hide the video with no
// explanation. Callers surface this as a validation error instead of storing it.
export function isImpossibleWindow(publishAt, expiresAt) {
  return publishAt !== null && expiresAt !== null && expiresAt <= publishAt;
}

// --- Redis ---

export async function listSchedules() {
  const all = (await redis.hgetall(k(KEY))) || {};
  const out = {};
  for (const [videoId, raw] of Object.entries(all)) {
    const entry = parseEntry(raw);
    if (entry) out[videoId] = entry;
  }
  return out;
}

export async function getSchedule(videoId) {
  return parseEntry(await redis.hget(k(KEY), String(videoId)));
}

// Clearing both bounds DELETES the entry rather than storing nulls, so
// "unscheduled" is represented by absence — the same additive shape the
// watermark override uses, and it keeps listSchedules() free of dead rows.
export async function setSchedule(videoId, { publishAt, expiresAt }) {
  const id = String(videoId);
  const p = toTimestamp(publishAt);
  const e = toTimestamp(expiresAt);

  if (isImpossibleWindow(p, e)) {
    throw new Error('The expiry time must be after the publish time.');
  }

  if (p === null && e === null) {
    await redis.hdel(k(KEY), id);
    return null;
  }

  const entry = { publishAt: p, expiresAt: e };
  await redis.hset(k(KEY), { [id]: JSON.stringify(entry) });
  return entry;
}

export async function clearSchedule(videoId) {
  await redis.hdel(k(KEY), String(videoId));
}
