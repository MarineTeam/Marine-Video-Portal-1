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
// Two optional extras ride on the same entry (see their sections below):
//   repeat  { days, start, end, timeZone } — weekly slots that NARROW the
//           default window ("Sundays 09:00-13:00");
//   groups  { <groupId>: { publishAt, expiresAt } } — a group's own window,
//           which only ever ADDS time for that group's members.
//
// Staff bypass this entirely: an admin curating next week's release has to be
// able to see, play and check the video before it goes live. The admin UI
// badges those rows so "scheduled" never looks like "broken".

const KEY = 'video_schedule';

export const STATE_LIVE = 'live';
export const STATE_SCHEDULED = 'scheduled'; // not published yet
export const STATE_EXPIRED = 'expired';
export const STATE_NONE = 'none'; // no schedule set
export const STATE_OFF_SLOT = 'off-slot'; // inside its dates, between weekly slots

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
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const publishAt = toTimestamp(obj.publishAt);
    const expiresAt = toTimestamp(obj.expiresAt);
    const repeat = normalizeRepeat(obj.repeat);
    const groups = normalizeGroupWindows(obj.groups);
    if (publishAt === null && expiresAt === null && !repeat && !groups) return null;
    const entry = { publishAt, expiresAt };
    if (repeat) entry.repeat = repeat;
    if (groups) entry.groups = groups;
    return entry;
  } catch {
    return null;
  }
}

// --- Repeating windows ---------------------------------------------------
//
// A weekly slot on the DEFAULT window: { days: [0-6, Sunday = 0], start:
// 'HH:MM', end: 'HH:MM', timeZone: IANA name }. When present, a viewer sees
// the video only inside a slot (as well as inside publishAt/expiresAt). A slot
// whose end is not after its start runs past midnight into the next day —
// 'Saturday 22:00-02:00'. The zone is the one the rule was saved in, so
// summer time does not move the slot.
//
// It narrows the default window only, and it lives inside scheduleState(),
// which isVisibleNow() and so every enforcement point (and the public page)
// already use — there is no new call site to forget. Group windows are
// separate grants and are not bound by it.
//
// A malformed stored rule reads as NO rule, the same as an unusable date
// above; validateRepeat() refuses one on the way in.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(time) {
  const m = TIME.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function normalizeRepeat(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort();
  const start = minutesOf(raw.start);
  const end = minutesOf(raw.end);
  if (!days.length || start === null || end === null || start === end) return null;
  if (!isValidTimeZone(raw.timeZone)) return null;
  return { days, start: raw.start, end: raw.end, timeZone: raw.timeZone };
}

// The weekday (0-6) and minute of the day at `now`, in `timeZone`.
function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: WEEKDAYS[get('weekday')], minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Whether `now` falls inside one of the rule's weekly slots. No usable rule
// means no constraint.
export function inRepeatSlot(repeat, now = Date.now()) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return true;
  const { day, minute } = localClock(now, rule.timeZone);
  const start = minutesOf(rule.start);
  const end = minutesOf(rule.end);
  return rule.days.some((d) => {
    if (start < end) return day === d && minute >= start && minute < end;
    // Past midnight: the evening of day d, and the early hours of the next.
    return (day === d && minute >= start) || (day === (d + 1) % 7 && minute < end);
  });
}

// Refuses a rule that would not do what the admin meant. Returns an error
// string, or null (including for "no rule").
export function validateRepeat(repeat) {
  if (repeat === undefined || repeat === null) return null;
  if (typeof repeat !== 'object' || Array.isArray(repeat)) return 'The repeat rule is not valid.';
  const days = Array.isArray(repeat.days) ? repeat.days : [];
  if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return 'Choose at least one day for the repeat.';
  }
  const start = minutesOf(repeat.start);
  const end = minutesOf(repeat.end);
  if (start === null || end === null) return 'Repeat times must be HH:MM.';
  if (start === end) return 'A repeat slot must not start and end at the same time.';
  if (!isValidTimeZone(repeat.timeZone)) return 'The repeat time zone is not recognised.';
  return null;
}

// --- Per-group windows ---------------------------------------------------
//
// groups: { <groupId>: { publishAt, expiresAt } } — "members of this group
// can ALSO watch during this window". ADDITIVE ONLY, never a way to hold a
// video back from a group:
//
//   * every place that checks a window has to be handed the viewer's groups,
//     and one will eventually be missed. With additive windows a missed call
//     site only withholds an early preview (the default window applies) —
//     the safe direction. A window that could DELAY a video for a group would
//     turn the same slip into showing it early.
//   * holding a video back from a group is what group grants are for, and
//     they are checked BEFORE the window (canSeeVideo), so a group window
//     never reaches a viewer the video's grants exclude.
//
// Group ids are random UUIDs (lib/groups.js), so a new group can never
// inherit an old one's windows by name; deleting a group still prunes its
// windows (pruneGroupFromSchedules) so no entry names a group that is gone.

export const MAX_GROUP_WINDOWS = 20;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUsableGroupKey(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && !RESERVED_KEYS.has(id);
}

// Stored group windows, cleaned: unusable ids and empty or impossible
// windows are dropped. Returns null when none are left.
function normalizeGroupWindows(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (count >= MAX_GROUP_WINDOWS) break;
    if (!isUsableGroupKey(id) || !value || typeof value !== 'object') continue;
    const publishAt = toTimestamp(value.publishAt);
    const expiresAt = toTimestamp(value.expiresAt);
    if (publishAt === null && expiresAt === null) continue;
    if (isImpossibleWindow(publishAt, expiresAt)) continue;
    out[id] = { publishAt, expiresAt };
    count += 1;
  }
  return count ? out : null;
}

// Admin input, checked against the groups that exist. Returns { groups }
// (null for none) or { error }. A window for an unknown group is refused
// rather than stored.
export function validateGroupWindows(raw, knownGroupIds) {
  if (raw === undefined || raw === null) return { groups: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Group windows must be an object.' };
  const entries = Object.entries(raw);
  if (entries.length > MAX_GROUP_WINDOWS) return { error: `At most ${MAX_GROUP_WINDOWS} group windows.` };
  const known = new Set(knownGroupIds || []);
  const out = {};
  for (const [id, value] of entries) {
    if (!isUsableGroupKey(id) || !known.has(id)) {
      return { error: 'One of the groups no longer exists — reload and try again.' };
    }
    const publishAt = toTimestamp(value?.publishAt);
    const expiresAt = toTimestamp(value?.expiresAt);
    if (isImpossibleWindow(publishAt, expiresAt)) {
      return { error: "A group's expiry time must be after its publish time." };
    }
    if (publishAt !== null || expiresAt !== null) out[id] = { publishAt, expiresAt };
  }
  return { groups: Object.keys(out).length ? out : null };
}

// --- Pure helpers (no Redis; unit-tested in lib/__tests__/schedule.test.js) ---

export function scheduleState(entry, now = Date.now()) {
  if (!entry) return STATE_NONE;
  const publishAt = entry.publishAt ?? null;
  const expiresAt = entry.expiresAt ?? null;
  const repeat = entry.repeat || null;
  if (publishAt === null && expiresAt === null && !repeat) return STATE_NONE;
  if (publishAt !== null && now < publishAt) return STATE_SCHEDULED;
  if (expiresAt !== null && now >= expiresAt) return STATE_EXPIRED;
  // A weekly repeat narrows the window further (see "Repeating windows").
  if (repeat && !inRepeatSlot(repeat, now)) return STATE_OFF_SLOT;
  return STATE_LIVE;
}

export function isVisibleNow(entry, now = Date.now()) {
  const state = scheduleState(entry, now);
  return state === STATE_NONE || state === STATE_LIVE;
}

// Whether a viewer in `groupIds` may see the video now: the default window,
// OR the window of any group they belong to. See "Per-group windows" for why
// this must stay an OR.
export function isVisibleFor(entry, groupIds, now = Date.now()) {
  if (isVisibleNow(entry, now)) return true;
  const groups = entry?.groups;
  if (!groups || !Array.isArray(groupIds)) return false;
  return groupIds.some(
    (id) =>
      isUsableGroupKey(id) &&
      Object.prototype.hasOwnProperty.call(groups, id) &&
      isVisibleNow({ publishAt: groups[id]?.publishAt ?? null, expiresAt: groups[id]?.expiresAt ?? null }, now)
  );
}

// `schedules` is a map of videoId -> entry (or null). Videos with no entry
// pass through untouched. `groupIds` is the viewer's groups, for per-group
// windows; leave it out for the default window only.
export function filterScheduled(schedules, videos, now = Date.now(), groupIds = null) {
  if (!schedules) return videos || [];
  return (videos || []).filter((v) => isVisibleFor(schedules[v.guid], groupIds, now));
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

// Clearing everything DELETES the entry rather than storing nulls, so
// "unscheduled" is represented by absence — the same additive shape the
// watermark override uses, and it keeps listSchedules() free of dead rows.
//
// The whole entry is written every time: the dates, the weekly `repeat`
// (validated by the caller with validateRepeat) and the per-group windows
// (validated by the caller with validateGroupWindows).
export async function setSchedule(videoId, { publishAt, expiresAt, repeat = null, groups = null }) {
  const id = String(videoId);
  const p = toTimestamp(publishAt);
  const e = toTimestamp(expiresAt);

  if (isImpossibleWindow(p, e)) {
    throw new Error('The expiry time must be after the publish time.');
  }

  const entry = parseEntry({ publishAt: p, expiresAt: e, repeat, groups });
  if (!entry) {
    await redis.hdel(k(KEY), id);
    return null;
  }
  await redis.hset(k(KEY), { [id]: JSON.stringify(entry) });
  return entry;
}

// Called when a group is deleted, so no entry is left naming it. A failure
// here is the caller's to report or tolerate.
export async function pruneGroupFromSchedules(groupId) {
  const gid = String(groupId || '');
  if (!isUsableGroupKey(gid)) return 0;
  const all = await listSchedules();
  let touched = 0;
  for (const [videoId, entry] of Object.entries(all)) {
    if (!entry.groups || !Object.prototype.hasOwnProperty.call(entry.groups, gid)) continue;
    const groups = { ...entry.groups };
    delete groups[gid];
    await setSchedule(videoId, { ...entry, groups });
    touched += 1;
  }
  return touched;
}

export async function clearSchedule(videoId) {
  await redis.hdel(k(KEY), String(videoId));
}
