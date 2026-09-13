import { redis, k } from './redis';
import { cleanNotes, parseChapters, normalizeChapters, normalizeMeta } from './videoMeta';

// Redis half of per-video chapters and notes. SERVER ONLY — never import this
// from a component; see the note at the top of lib/videoMeta.js.
//
// One hash keyed by video id holds both fields, so the Videos tab and the
// watch page each need a single read rather than one per field.

const KEY = 'video_meta';

export async function listVideoMeta() {
  try {
    const all = (await redis.hgetall(k(KEY))) || {};
    const out = {};
    for (const [videoId, raw] of Object.entries(all)) {
      const meta = normalizeMeta(raw);
      if (meta) out[videoId] = meta;
    }
    return out;
  } catch {
    // Chapters and notes are decoration on top of playback. An Upstash blip
    // must not blank the library or fail a watch page — same fail-soft posture
    // as lib/groups.js and lib/verification.js.
    return {};
  }
}

export async function getVideoMeta(videoId) {
  try {
    return normalizeMeta(await redis.hget(k(KEY), String(videoId)));
  } catch {
    return null;
  }
}

// Accepts the admin's raw textarea content. Returns the stored metadata plus
// the chapter lines that could not be parsed, so the route can report them.
//
// Clearing both fields DELETES the entry rather than storing empties, so
// "no metadata" is represented by absence — the same additive shape
// lib/schedule.js uses, and it keeps listVideoMeta() free of dead rows.
export async function setVideoMeta(videoId, { notes, chaptersText }) {
  const id = String(videoId);
  const existing = (await getVideoMeta(id)) || { notes: '', chapters: [] };

  const nextNotes = notes === undefined ? existing.notes : cleanNotes(notes);

  let nextChapters = existing.chapters;
  let ignored = [];
  if (chaptersText !== undefined) {
    const parsed = parseChapters(chaptersText);
    nextChapters = parsed.chapters;
    ignored = parsed.ignored;
  }
  nextChapters = normalizeChapters(nextChapters);

  if (!nextNotes && nextChapters.length === 0) {
    await redis.hdel(k(KEY), id);
    return { meta: null, ignored };
  }

  const meta = { notes: nextNotes, chapters: nextChapters };
  await redis.hset(k(KEY), { [id]: JSON.stringify(meta) });
  return { meta, ignored };
}

// Called when a video is deleted, so its metadata doesn't outlive it.
export async function clearVideoMeta(videoId) {
  try {
    await redis.hdel(k(KEY), String(videoId));
  } catch {
    // best-effort cleanup; a stale row is inert (its video id no longer resolves)
  }
}
