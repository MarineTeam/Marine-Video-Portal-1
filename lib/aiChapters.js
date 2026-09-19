// bunny.net's AI chapter suggestions, read into this repo's chapter shape.
//
// PURE module — imports only lib/videoMeta.js, which imports nothing. The
// admin page renders suggestions in the browser, so anything pulled in here
// lands in the client bundle and a lib/redis.js import would drag Node's
// async_hooks in and fail the build. Same split as videoMeta / videoMetaStore.
//
// SUGGESTIONS ARE NOT CHAPTERS. Nothing here writes, and the route that calls
// it writes nothing either. A suggestion becomes a chapter only when an admin
// loads it into the chapters textarea and saves, through the same
// PUT /api/admin/videos + parseChapters path a typed list takes. That is the
// whole feature: bunny can generate chapters from the transcript, but a second
// writer for the video-meta entry is how hand-written chapters get silently
// replaced, so the AI may propose and only a person may accept.
//
// SHAPE, and what is guessed about it. bunny's video object documents chapters
// as `[{ title, start, end }]` with the times in SECONDS, and moments as
// `[{ label, timestamp }]`. `title`/`start` are the documented names; the rest
// are accepted as fallbacks because this has never run against a live
// transcription job — a field spelled differently than the docs say should
// cost one wrong label, not an empty list with no explanation. Whatever cannot
// be read is REPORTED, never dropped quietly: the admin has to be able to tell
// "bunny generated nothing" from "bunny generated something we could not read".
// `ignored` is a list of STRINGS, the same shape parseChapters returns, so the
// admin page can show them the way it already shows skipped lines.
import { MAX_CHAPTERS, MAX_CHAPTER_LABEL, formatTimestamp } from './videoMeta';

// Documented name first; the rest are the defensive fallbacks described above.
const TIME_KEYS = ['start', 'timestamp', 'time'];
const LABEL_KEYS = ['title', 'label', 'text'];

function readTime(entry) {
  for (const key of TIME_KEYS) {
    const value = entry?.[key];
    // Empty and null are skipped rather than coerced: Number('') is 0, which
    // would turn a missing field into a chapter at 0:00 that reads like a real
    // suggestion.
    if (value === null || value === undefined || value === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds;
  }
  return null;
}

function readLabel(entry) {
  for (const key of LABEL_KEYS) {
    const label = String(entry?.[key] ?? '').trim().slice(0, MAX_CHAPTER_LABEL);
    if (label) return label;
  }
  return '';
}

// Reads a bunny video object's `chapters` (falling back to `moments`, the same
// idea under another name) into { chapters, ignored } — the same pair
// parseChapters returns, so a suggestion is held to the same standard as a
// line the admin typed and is reported the same way when it is not.
export function suggestedChapters(video) {
  const raw =
    Array.isArray(video?.chapters) && video.chapters.length
      ? video.chapters
      : Array.isArray(video?.moments)
        ? video.moments
        : [];

  const chapters = [];
  const ignored = [];

  raw.forEach((entry, i) => {
    const position = i + 1;
    const label = readLabel(entry);
    const seconds = readTime(entry);

    if (seconds === null || seconds < 0) {
      ignored.push(`#${position} ${label || '(untitled)'} — no usable start time`);
      return;
    }
    const at = Math.floor(seconds);
    if (!label) {
      ignored.push(`#${position} at ${formatTimestamp(at)} — no title`);
      return;
    }
    chapters.push({ seconds: at, label });
  });

  // Stable on equal timestamps, like parseChapters. The cap is applied AFTER
  // sorting, so an over-long suggestion list keeps the start of the video
  // rather than whatever bunny happened to send first.
  chapters.sort((a, b) => a.seconds - b.seconds);
  for (const dropped of chapters.slice(MAX_CHAPTERS)) {
    ignored.push(`${formatTimestamp(dropped.seconds)} ${dropped.label} — over the ${MAX_CHAPTERS}-chapter limit`);
  }
  return { chapters: chapters.slice(0, MAX_CHAPTERS), ignored };
}

// Whether a suggested list would change anything. Lets the admin page say
// "these match what you already have" instead of offering a replacement that
// does nothing — and makes accepting feel safe, because the one case where it
// costs the admin nothing is named out loud.
export function sameChapters(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((chapter, i) => {
    const other = right[i];
    return (
      Math.floor(Number(chapter?.seconds)) === Math.floor(Number(other?.seconds)) &&
      String(chapter?.label || '') === String(other?.label || '')
    );
  });
}
