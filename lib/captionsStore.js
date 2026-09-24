import { randomUUID } from 'node:crypto';
import { redis, k } from './redis';
import { MAX_CUES, isLanguageCode, normalizeLanguages, transcriptText } from './captions';

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
// Additional languages, keyed `${videoId}:${lang}`, and a small index of which
// languages a video has.
//
// A SEPARATE hash rather than more fields in CUES_KEY. Nothing here reads that
// hash's field names today — unlike the sibling repos, where an hkeys-driven
// admin badge would report `vid:es` as a transcribed video that does not
// exist. Keeping the shapes apart anyway: one hash with two field shapes is a
// trap laid for whoever adds that read later, and it costs nothing to avoid.
const ALT_KEY = 'transcripts_alt';
const LANGS_KEY = 'transcript_langs';

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

// Which languages a video has, and which is its default. Fails soft to "one
// unnamed track", which is what every transcript written before languages
// existed actually is.
export async function getTranscriptLanguages(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return { default: null, all: [] };
  let raw;
  try {
    raw = await redis.hget(k(LANGS_KEY), id);
  } catch (e) {
    console.error('Could not read transcript languages:', e);
    return { default: null, all: [] };
  }
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { default: null, all: [] };
    }
  }
  const all = normalizeLanguages(value?.all);
  const preferred = String(value?.default || '').trim().toLowerCase();
  return { default: all.includes(preferred) ? preferred : all[0] || null, all };
}

// One additional language. Deliberately does NOT write the text hash: search
// reads one language per video, and indexing every translation of the same
// sermon would multiply the search payload to return the same video.
export async function setTranscriptLanguage(videoId, lang, cues) {
  const id = String(videoId || '').trim();
  const code = String(lang || '').trim().toLowerCase();
  if (!id || !isLanguageCode(code)) return { ok: false, error: 'Bad request' };
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return { ok: false, error: 'Empty transcript' };
  try {
    await redis.hset(k(ALT_KEY), { [`${id}:${code}`]: JSON.stringify(list) });
    return { ok: true, cues: list.length };
  } catch (e) {
    console.error('Could not store a translated transcript:', e);
    return { ok: false, error: 'Could not store the transcript' };
  }
}

// Records which languages a video has. `defaultLang` names the track stored in
// the main hash, so a read knows which language it is getting when nobody asks.
export async function setTranscriptLanguages(videoId, defaultLang, langs) {
  const id = String(videoId || '').trim();
  if (!id) return;
  const all = normalizeLanguages(langs);
  const preferred = String(defaultLang || '').trim().toLowerCase();
  try {
    if (!all.length) {
      await redis.hdel(k(LANGS_KEY), id);
      return;
    }
    await redis.hset(k(LANGS_KEY), {
      [id]: JSON.stringify({ default: all.includes(preferred) ? preferred : all[0], all }),
    });
  } catch (e) {
    // Losing the index costs the picker, not the transcript.
    console.error('Could not record transcript languages:', e);
  }
}

// With no language, or the video's default one, this reads exactly the field
// it always read — the default track stays where it was, so nothing about an
// existing transcript had to be migrated to add languages beside it.
export async function getTranscript(videoId, lang = null) {
  const id = String(videoId || '').trim();
  if (!id) return [];
  const code = String(lang || '').trim().toLowerCase();
  try {
    if (!code || !isLanguageCode(code)) return parseCues(await redis.hget(k(CUES_KEY), id));
    const { default: fallback } = await getTranscriptLanguages(id);
    if (code === fallback) return parseCues(await redis.hget(k(CUES_KEY), id));
    return parseCues(await redis.hget(k(ALT_KEY), `${id}:${code}`));
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
  if (!id) return { ok: true, cues: 0 };
  // The alt fields are named per language, so the index has to be read BEFORE
  // it is deleted or there is nothing left to say what to clean up. That is
  // why the index exists rather than being derived by scanning.
  const { all } = await getTranscriptLanguages(id);
  try {
    await redis.hdel(k(CUES_KEY), id);
    await redis.hdel(k(TEXT_KEY), id);
    await redis.hdel(k(LANGS_KEY), id);
    if (all.length) {
      await redis.hdel(k(ALT_KEY), ...all.map((code) => `${id}:${code}`));
    }
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
// A marker, not a job. The admin video list and the scheduled job
// (pages/api/cron/transcripts.js) check these and ingest whatever bunny has
// finished (see lib/transcribeQueue.js for why).
// Every function swallows its own errors — a marker that cannot be written
// costs the admin the second click they used to make anyway, and must never
// fail the request that spent the money.
//
// NOT a per-viewer key family, so it is deliberately absent from
// lib/maintenance.js's VIEWER_KEY_PREFIXES: it is keyed by video and cleared
// on ingest or by its own three-day deadline, so it cannot accumulate orphans
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

// --- One collector at a time ------------------------------------------------
//
//   pvp:transcribe_collecting  random token, expires after five minutes
//
// Collection can start from two places at once — an admin loading the video
// list while the scheduled job runs, or the scheduler delivering one run twice
// (Vercel says it can). Both would fetch the same captions from bunny and log
// the same "collected" line twice. The lock makes the second one skip; the
// work it skipped is still pending and is picked up next time.
//
// The token is compared on release, so a run that outlived its lock can never
// delete a lock a newer run now holds. A lock that cannot be taken is treated
// as held: skipping is always safe here, and collecting twice is the thing
// being prevented. Not per-viewer, and it expires on its own, so it is not a
// lib/maintenance.js concern either.
const COLLECT_LOCK_SECONDS = 5 * 60;
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export async function acquireCollectLock() {
  const token = `lock-${randomUUID()}`;
  try {
    const ok = await redis.set(k('transcribe_collecting'), token, { nx: true, ex: COLLECT_LOCK_SECONDS });
    return ok === 'OK' ? token : null;
  } catch (e) {
    console.error('Could not take the transcript collection lock:', e);
    return null;
  }
}

export async function releaseCollectLock(token) {
  if (!token) return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, [k('transcribe_collecting')], [token]);
  } catch (e) {
    // It expires on its own; the next run waits at most five minutes.
    console.error('Could not release the transcript collection lock:', e);
  }
}
