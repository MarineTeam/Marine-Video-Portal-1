import { redis, k } from './redis';
import { MAX_CUES, transcriptText } from './captions';

// Redis half of per-video transcripts. SERVER ONLY — never import this from a
// component; see the note at the top of lib/captions.js.
//
// TWO hashes, unlike lib/videoMetaStore.js which puts both its fields in one.
// The reason is the access pattern rather than taste:
//
//   pvp:transcripts      videoId -> [{ start, end, text }, ...]
//   pvp:transcript_text  videoId -> the same words as one string
//
// The watch page wants one video's cues and reads a single field. Library
// search wants "which videos said this?" across everything, which is one
// hgetall — and cues are bulky (~1,500 per 90-minute service, two timings
// each). Pulling all of that to use none of the timings is a cost that only
// shows up once the library is large. Chapters and notes share a hash because
// both are small and both are always read together; transcripts are neither.
//
// Reads fail back to "no transcript": a transcript is sugar over a video that
// plays fine without it, so an unreadable value must degrade to today's
// behaviour rather than break the watch page.

const CUES_KEY = 'transcripts';
const TEXT_KEY = 'transcript_text';

function parseCues(raw) {
  if (!raw) return [];
  try {
    // Upstash may hand back an already-parsed value or a JSON string
    // depending on what was written; accept both rather than assuming.
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value
      .filter((cue) => cue && typeof cue.text === 'string')
      .slice(0, MAX_CUES)
      .map((cue) => ({
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
        text: cue.text,
      }));
  } catch (e) {
    console.error('Could not parse a stored transcript:', e);
    return [];
  }
}

export async function getTranscript(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return [];
  try {
    return parseCues(await redis.hget(k(CUES_KEY), id));
  } catch (e) {
    console.error('Could not read a transcript:', e);
    return [];
  }
}

// videoId -> plain transcript text, for library search. Deliberately NOT the
// cue array — see the two-hash note above.
export async function listTranscriptText() {
  try {
    const all = (await redis.hgetall(k(TEXT_KEY))) || {};
    const out = {};
    for (const [videoId, value] of Object.entries(all)) {
      if (typeof value === 'string' && value) out[videoId] = value;
    }
    return out;
  } catch (e) {
    console.error('Could not read transcripts for search:', e);
    return {};
  }
}

// Writes both hashes together. Callers pass cues from parseVtt().
export async function setTranscript(videoId, cues) {
  const id = String(videoId || '').trim();
  if (!id) return { ok: false, error: 'Invalid videoId' };
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return clearTranscript(id);
  try {
    await redis.hset(k(CUES_KEY), { [id]: JSON.stringify(list) });
    await redis.hset(k(TEXT_KEY), { [id]: transcriptText(list) });
    return { ok: true, cues: list.length };
  } catch (e) {
    // Unlike a read, a write failure is worth reporting: an admin pressed a
    // button and is owed an answer.
    console.error('Could not store a transcript:', e);
    return { ok: false, error: 'Could not store the transcript' };
  }
}

export async function clearTranscript(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return { ok: false, error: 'Invalid videoId' };
  try {
    await redis.hdel(k(CUES_KEY), id);
    await redis.hdel(k(TEXT_KEY), id);
    return { ok: true, cues: 0 };
  } catch (e) {
    console.error('Could not clear a transcript:', e);
    return { ok: false, error: 'Could not clear the transcript' };
  }
}

// --- The queue of transcriptions waiting to be collected -------------------
//
//   pvp:transcribe_pending  videoId -> epoch ms when it was queued
//
// A marker, not a job: nothing runs it. The admin video list checks these and
// ingests whatever bunny has finished (see lib/transcribeQueue.js for why).
// Every function swallows its own errors — a marker that cannot be written
// costs the admin the second click they used to make anyway, and must never
// fail the request that spent the money.
//
// NOT a per-viewer key family, so it is deliberately absent from
// lib/maintenance.js's VIEWER_KEY_PREFIXES: it is keyed by video and cleared
// on ingest or by its own 24-hour deadline, so it cannot accumulate orphans
// the way weak point #3 describes.
export async function markTranscribePending(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return;
  try {
    await redis.hset(k('transcribe_pending'), { [id]: Date.now() });
  } catch (e) {
    console.error('Could not record a pending transcription:', e);
  }
}

export async function getTranscribePending() {
  try {
    return (await redis.hgetall(k('transcribe_pending'))) || {};
  } catch (e) {
    console.error('Could not read the pending transcriptions:', e);
    return {};
  }
}

export async function clearTranscribePending(videoIds) {
  const ids = (Array.isArray(videoIds) ? videoIds : [videoIds])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (!ids.length) return;
  try {
    await redis.hdel(k('transcribe_pending'), ...ids);
  } catch (e) {
    console.error('Could not clear a pending transcription:', e);
  }
}
