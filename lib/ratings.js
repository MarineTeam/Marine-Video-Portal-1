// Per-viewer ratings: was this worth watching?
//
// PURE — imports nothing, for the same reason as lib/videoMeta.js and
// lib/mylist.js: the watch page renders the buttons in the browser, so
// anything pulled in here lands in the client bundle and a lib/redis import
// would drag Node built-ins in and fail the build. Redis lives in
// lib/ratingsStore.js, the same split as videoMeta.js / videoMetaStore.js.
//
// TWO STRUCTURES, and the split is the privacy decision:
//
//   k(`ratings:${email}`)  videoId -> 'up' | 'down'    the truth, per viewer
//   k('rating_counts')     `${videoId}:up` -> integer  totals, no identities
//
// The vote is stored under the VIEWER's key, not the video's, so removing a
// viewer takes their votes with them — the same sweep that already clears
// their progress and saved list. A hash keyed by video would have kept a
// removed person's address in a row nothing cleans.
//
// The counters therefore hold no email at all. They are maintained by
// incrementing a delta on each vote rather than by counting rows, which means
// one HGETALL gives an admin every video's totals, and a viewer's identity is
// never derivable from them.
//
// WHO SEES WHAT: a viewer sees their OWN rating and nothing else. Totals are
// staff-only. In a library watched by a few dozen people a visible '2 down' on
// a talk is a social problem the product does not need, and at that N a public
// counter is close to attributable anyway — three viewers and one downvote is
// a guess with good odds. The counts exist so an admin can see what landed,
// not so viewers can rank each other's teaching.

export const UP = 'up';
export const DOWN = 'down';
const VOTES = [UP, DOWN];

// Anything that is not exactly one of the two votes is 'no rating'. Strict on
// purpose: a stored value from a future third option must read as absent
// rather than as one of the two we know.
export function normalizeVote(value) {
  const vote = String(value || '').trim().toLowerCase();
  return VOTES.includes(vote) ? vote : null;
}

// One viewer's whole map, cleaned. A malformed record degrades to 'not rated'
// rather than throwing into a page render — the same posture chapters take.
export function normalizeRatings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [videoId, value] of Object.entries(raw)) {
    const id = String(videoId || '').trim();
    const vote = normalizeVote(value);
    if (id && vote) out[id] = vote;
  }
  return out;
}

export function ratingOf(raw, videoId) {
  const id = String(videoId || '').trim();
  if (!id) return null;
  return normalizeRatings(raw)[id] || null;
}

// The counter field names. Kept here, next to the module that reads them back,
// so the two halves can never drift apart.
export function countField(videoId, vote) {
  const id = String(videoId || '').trim();
  const v = normalizeVote(vote);
  return id && v ? `${id}:${v}` : null;
}

// What changing a vote does to the two counters. Returns the deltas to apply,
// which is what makes a re-vote cheap and a repeated vote free.
//
//   null -> 'up'    { up: +1, down:  0 }
//   'up' -> 'down'  { up: -1, down: +1 }
//   'up' -> 'up'    { up:  0, down:  0 }   nothing happened
//   'up' -> null    { up: -1, down:  0 }   cleared
export function voteDelta(previous, next) {
  const before = normalizeVote(previous);
  const after = normalizeVote(next);
  const delta = { [UP]: 0, [DOWN]: 0 };
  if (before === after) return delta;
  if (before) delta[before] -= 1;
  if (after) delta[after] += 1;
  return delta;
}

// The counters hash back into per-video totals. Never negative: a counter that
// has drifted below zero (a half-failed write — see the note in lib/store.js)
// is a display bug, and showing '-1 up' would make it look like data loss.
export function countsByVideo(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [field, value] of Object.entries(raw)) {
    const marker = String(field || '').lastIndexOf(':');
    if (marker <= 0) continue;
    const videoId = field.slice(0, marker);
    const vote = normalizeVote(field.slice(marker + 1));
    const count = Number(value);
    if (!videoId || !vote || !Number.isFinite(count)) continue;
    if (!out[videoId]) out[videoId] = { [UP]: 0, [DOWN]: 0 };
    out[videoId][vote] = Math.max(0, Math.floor(count));
  }
  return out;
}

export function countsFor(byVideo, videoId) {
  const id = String(videoId || '').trim();
  const entry = (byVideo && byVideo[id]) || null;
  return { [UP]: Number(entry?.[UP]) || 0, [DOWN]: Number(entry?.[DOWN]) || 0 };
}

// A one-line summary for the admin list. Returns null when nobody has voted,
// so the UI can show nothing at all rather than a row of zeroes that reads
// like a bad score.
export function summarize(counts) {
  const up = Number(counts?.[UP]) || 0;
  const down = Number(counts?.[DOWN]) || 0;
  if (up + down === 0) return null;
  return { up, down, total: up + down };
}
