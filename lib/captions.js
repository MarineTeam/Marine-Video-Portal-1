// WebVTT parsing and transcript search for a single video.
//
// A 60-90 minute recording is hard to re-enter: chapters (lib/chapters.js) give
// you the admin's hand-written way in, and this gives you the machine's — every
// spoken line, timestamped and seekable, and searchable across the library by
// what was actually said rather than by title alone.
//
// PURE MODULE — no Redis import, deliberately, for the same reason
// lib/videoMeta.js is pure: the watch page renders the transcript in the browser,
// so anything this imports lands in the client bundle, and pulling lib/redis.js
// in here would drag Node built-ins (async_hooks, via lib/monitor.js) into that
// bundle and fail the build. Storage lives in lib/captionsStore.js — the same pure/store split this
// repo uses for lib/videoMeta.js vs lib/videoMetaStore.js.

// A transcript is only useful if it stays bounded. A 90-minute service is
// roughly 1,200-1,800 cues; the ceiling is well above that but still refuses a
// pathological file rather than holding it all in a Redis value.
export const MAX_CUES = 10000;
export const MAX_CUE_TEXT = 500;

// WebVTT timestamps are HH:MM:SS.mmm or MM:SS.mmm, separated by '-->'.
// Trailing cue settings (align:start position:50%) are allowed and ignored.
const TIMING = /^(\d{1,3}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,3}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

// Inline markup WebVTT permits inside cue text: <v Speaker>, <c.classname>,
// <00:00:01.000> karaoke stamps, <i>/<b>/<u>. Strip the tags, keep the words.
const TAG = /<[^>]*>/g;

// Anything bracket-shaped that survived TAG. An UNTERMINATED tag has no '>',
// so TAG cannot match it and leaves it whole — '<script' passes through a
// single tag-strip untouched, which is what CodeQL's incomplete-multi-
// character-sanitization rule is pointing at. Removing every remaining
// bracket afterwards means the output provably contains no '<' at all, so no
// tag-shaped string can be reconstructed from it by any later consumer.
//
// Not currently reachable as an injection: the transcript is rendered only
// through React, which escapes, and never reaches the podcast XML, mail, or
// dangerouslySetInnerHTML. This is the sanitizer doing the job it claims to
// do, so that staying true does not depend on every future consumer of a
// stored transcript escaping correctly.
//
// Speech-to-text output has no legitimate angle brackets, so nothing is lost.
const STRAY_BRACKET = /[<>]/g;

// Control and formatting characters, including anything pasted out of a word
// processor. Same guard as lib/chapters.js's cleanLabel.
const CONTROL = /\p{Cc}|\p{Cf}/gu;

function toSeconds(hours, minutes, seconds, millis) {
  const h = hours ? parseInt(hours, 10) : 0;
  const m = parseInt(minutes, 10);
  const s = parseInt(seconds, 10);
  // '1' and '100' both mean tenths-to-millis depending on width, so pad rather
  // than parsing naively: '.1' is 100ms, not 1ms.
  const ms = parseInt(String(millis).padEnd(3, '0'), 10);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function cleanText(value) {
  return String(value)
    .replace(TAG, '')
    .replace(STRAY_BRACKET, '')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CUE_TEXT);
}

// Parses a WebVTT file into ordered cues.
//
// Returns [] for anything unparseable rather than throwing: a missing or
// malformed caption file must degrade to 'no transcript', never to a broken
// watch page. The caller cannot tell the difference between 'not transcribed'
// and 'transcribed badly', and for rendering purposes it does not matter.
export function parseVtt(text) {
  if (typeof text !== 'string' || !text) return [];

  const cues = [];
  // \r\n and \r both appear in the wild; normalise before splitting so a CRLF
  // file does not leave a stray \r on every cue.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length && cues.length < MAX_CUES; i += 1) {
    const match = TIMING.exec(lines[i].trim());
    if (!match) continue;

    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);

    // Cue text is every line until the next blank line.
    const parts = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) break;
      parts.push(lines[j]);
      i = j;
    }

    const body = cleanText(parts.join(' '));
    // A timing line with no text is legal VTT and useless here.
    if (!body) continue;
    // An end before its start is a malformed file; keep the cue seekable by
    // its start rather than dropping a line of the transcript.
    cues.push({ start, end: end > start ? end : start, text: body });
  }

  return cues;
}

// Joins cues into one readable block — what a 'copy the transcript' button
// hands over, and what a coarse full-text search matches against.
export function transcriptText(cues) {
  if (!Array.isArray(cues)) return '';
  return cues.map((cue) => cue?.text || '').filter(Boolean).join(' ');
}

// Case- and punctuation-insensitive needle. Matching raw would make 'Christ's'
// and 'Christs' different words, which is not what anyone typing into a search
// box means.
//
// Apostrophes are DELETED while other punctuation becomes a space, and the two
// must not be collapsed into one rule. Spacing an apostrophe splits 'Christ's'
// into 'christ s', so a search for 'christs' misses it; deleting a hyphen joins
// 'end-of-line' into 'endofline', so a search for 'end of line' misses that.
// Each mark is handled the way it is actually used.
const APOSTROPHE = /['‘’ʼ]/g;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(APOSTROPHE, '')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The same normaliser, for the transcript store: translations are stored
// already normalised so they can be searched inside Redis (see
// matchingTranslatedGuids in lib/captionsStore.js), and the query has to be
// normalised by exactly this function for that to agree with the default
// track's matching.
export const normalizeSpokenText = normalize;

// Cues containing the query, with their index so a caller can render context.
// An empty or whitespace query matches nothing rather than everything — a
// blank search box should not dump the entire transcript.
export function findCues(cues, query) {
  const needle = normalize(query);
  if (!needle || !Array.isArray(cues)) return [];
  return cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => normalize(cue?.text).includes(needle))
    .map(({ cue, index }) => ({ ...cue, index }));
}

// Does this transcript mention the query at all? Used by library search, which
// only needs a yes/no per video, not the matching cues.
export function transcriptMatches(cues, query) {
  const needle = normalize(query);
  if (!needle || !Array.isArray(cues)) return false;
  return normalize(transcriptText(cues)).includes(needle);
}

// The cue playing at a given time, or null. Drives 'highlight the line we are
// on' as the video plays.
export function cueAt(cues, seconds) {
  if (!Array.isArray(cues) || typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }
  for (const cue of cues) {
    if (seconds >= cue.start && seconds < cue.end) return cue;
  }
  return null;
}

// '1:04:07' / '4:07' — matches how lib/chapters.js renders its stamps, so the
// two lists on the watch page read as one thing.
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Which videos said this? Takes the TEXT map (guid -> joined words), not cue
// arrays: search needs none of the timings, and the cue bodies are bulky
// enough that reading them for every search is the cost the two-hash split in
// lib/captionsStore.js exists to avoid.
export function matchingTranscriptGuids(textByGuid, query) {
  const needle = normalize(query);
  if (!needle) return [];
  return Object.entries(textByGuid || {})
    .filter(([, text]) => normalize(text).includes(needle))
    .map(([guid]) => guid)
    .sort();
}

// --- Languages -------------------------------------------------------------
//
// bunny can produce a transcript in many languages; this portal ingests every
// track it finds and lets the viewer choose. These helpers are PURE and shared
// by the route, the store and the panel, so all three agree on which language
// a request means.

// bunny returns caption languages as ISO 639-1-ish shortcodes.
const LANG_CODE = /^[A-Za-z0-9-]{2,12}$/;

export function isLanguageCode(value) {
  return LANG_CODE.test(String(value || '').trim());
}

// Cleans a list of language codes: trimmed, lowercased, deduped, sorted, and
// with anything unusable dropped. Sorted so the picker does not reorder itself
// between requests for reasons the viewer cannot see.
export function normalizeLanguages(list) {
  const out = new Set();
  for (const value of Array.isArray(list) ? list : []) {
    const code = String(value || '').trim().toLowerCase();
    if (isLanguageCode(code)) out.add(code);
  }
  return [...out].sort();
}

// Which language to serve. The order is deliberate:
//
//   1. what was asked for, IF it exists — never silently substitute, or a
//      viewer who picked Spanish reads English and assumes the translation is
//      wrong rather than absent
//   2. the video's own default (the track ingested first)
//   3. English, the preference this portal was built around
//   4. whatever there is
//
// Returns null when there is nothing at all, which the caller reads as "no
// transcript" — the same answer a video that was never transcribed gives.
export function pickLanguage(available, requested, fallback = null) {
  const langs = normalizeLanguages(available);
  if (!langs.length) return null;
  const asked = String(requested || '').trim().toLowerCase();
  if (asked && langs.includes(asked)) return asked;
  const preferred = String(fallback || '').trim().toLowerCase();
  if (preferred && langs.includes(preferred)) return preferred;
  if (langs.includes('en')) return 'en';
  return langs[0];
}

// Whether a request named a language that does not exist. The route reports
// this so the panel can say "no Spanish transcript" rather than quietly
// showing English under a Spanish selection.
export function languageMissing(available, requested) {
  const asked = String(requested || '').trim().toLowerCase();
  if (!asked) return false;
  return !normalizeLanguages(available).includes(asked);
}
