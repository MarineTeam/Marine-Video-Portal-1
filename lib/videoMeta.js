// Per-video admin-authored metadata: chapter markers and notes.
//
// PURE module — no Redis import, safe to use from client code. The Redis half
// lives in lib/videoMetaStore.js. Same split as lib/branding.js vs
// lib/brandingStore.js, and for the same reason: pages/admin.js parses chapter
// text in the browser to show the admin what it understood, and importing
// lib/redis.js into a component pulls Node's async_hooks into the client
// bundle and fails the build.
//
// Both fields are ADDITIVE: a video with neither stores no entry at all and
// behaves exactly as it did before this existed. Same rule as lib/schedule.js
// and lib/groups.js — a default that changes what viewers see on deploy is
// indistinguishable from an outage.

export const MAX_NOTES_LENGTH = 2000;
export const MAX_CHAPTERS = 100;
export const MAX_CHAPTER_LABEL = 120;

// Strips control characters (which would break the admin textarea round-trip
// and could smuggle a line into an email) but keeps newlines, since notes are
// rendered with line breaks preserved.
export function cleanNotes(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
}

// "24:15", "1:02:03", "0:00" -> seconds. Returns null for anything else.
//
// Deliberately strict about shape but lenient about leading zeros. A bare
// number is rejected: "12" is far more likely to be a typo'd timestamp than a
// deliberate 12-second mark, and silently accepting it would put a chapter in
// the wrong place rather than telling the admin to fix the line.
export function parseTimestamp(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) return null;

  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;

  let hours = 0;
  let minutes;
  let seconds;
  if (parts.length === 3) [hours, minutes, seconds] = parts;
  else [minutes, seconds] = parts;

  // 90 minutes is a plausible way to write 1:30:00, but 1:75 is a typo. Reject
  // out-of-range seconds; allow minutes >= 60 only when there's no hours field.
  if (seconds > 59) return null;
  if (parts.length === 3 && minutes > 59) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// Parses the admin's textarea, one chapter per line: "24:15 Sermon".
// Separators between the timestamp and label (space, dash, en/em dash, colon)
// are all accepted and stripped.
//
// Returns BOTH the chapters and the lines it could not use, so the admin can
// be told what was ignored. Silently dropping a mistyped line is how someone
// ends up wondering why their chapter list is short.
export function parseChapters(text) {
  const chapters = [];
  const ignored = [];

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d{1,2}(?::\d{1,2}){1,2})\s*[-–—:]?\s*(.*)$/);
    const seconds = match ? parseTimestamp(match[1]) : null;
    if (seconds === null) {
      ignored.push(line);
      continue;
    }

    const label = match[2].trim().slice(0, MAX_CHAPTER_LABEL);
    if (!label) {
      ignored.push(line);
      continue;
    }

    chapters.push({ seconds, label });
  }

  // Sorted on the way in so nothing downstream has to care about input order,
  // and stable on equal timestamps so two marks at the same second keep the
  // order the admin typed them.
  chapters.sort((a, b) => a.seconds - b.seconds);

  return { chapters: chapters.slice(0, MAX_CHAPTERS), ignored };
}

// The inverse, for populating the admin textarea from stored chapters.
export function formatChaptersText(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((c) => `${formatTimestamp(c.seconds)} ${c.label}`)
    .join('\n');
}

// Normalizes whatever came back from Redis. Anything malformed degrades to
// "no chapters" rather than throwing into a page render.
export function normalizeChapters(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => {
      const seconds = Number(c?.seconds);
      const label = String(c?.label ?? '').trim().slice(0, MAX_CHAPTER_LABEL);
      if (!Number.isFinite(seconds) || seconds < 0 || !label) return null;
      return { seconds: Math.floor(seconds), label };
    })
    .filter(Boolean)
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, MAX_CHAPTERS);
}

export function normalizeMeta(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const notes = cleanNotes(obj.notes);
    const chapters = normalizeChapters(obj.chapters);
    if (!notes && chapters.length === 0) return null; // empty entry == no entry
    return { notes, chapters };
  } catch {
    return null;
  }
}

// Does this video's metadata match a search term? Title matching stays where
// it is in pages/api/videos.js; this only adds the notes half.
export function metaMatches(meta, lowercaseQuery) {
  if (!meta || !lowercaseQuery) return false;
  return (meta.notes || '').toLowerCase().includes(lowercaseQuery);
}
