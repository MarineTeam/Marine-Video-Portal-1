import { redis, k } from './redis';
import { normalizeRatings } from './ratings';
import { RECOUNT_SCRIPT, VOTE_SCRIPT } from './ratingScripts';

// Redis half of per-viewer ratings. SERVER ONLY — never import this from a
// component; see the note at the top of lib/ratings.js.
//
//   pvp:ratings:{email}  videoId -> 'up' | 'down'
//   pvp:rating_counts    {videoId}:up / {videoId}:down -> integer
//
// Keyed by email exactly like pvp:progress:{email} and pvp:mylist:{email}, and
// for the reason spelled out in lib/ratings.js: removing a viewer has to
// remove what was recorded about them, and there is no sweep over video keys.
// lib/maintenance.js sweeps this family too — a per-viewer key added without
// that line is how weak-point #3 was created in the first place.
//
// The counters are the exception and deliberately so: they hold integers and
// no address, so there is nothing about a removed viewer left in them.

const ratingsKey = (email) => k(`ratings:${String(email || '').trim().toLowerCase()}`);
const COUNTS = k('rating_counts');

export async function getRatings(email) {
  if (!String(email || '').trim()) return {};
  try {
    return normalizeRatings(await redis.hgetall(ratingsKey(email)));
  } catch (e) {
    // A vote is decoration over a video that plays fine without it, so an
    // unreadable value degrades to "not rated" rather than breaking the page.
    console.error('Could not read a rating:', e);
    return {};
  }
}

// Sets ('up' / 'down') or clears (null) one viewer's vote AND moves the
// counters, as one Redis script — see lib/ratingScripts.js. There is no
// separate counter write left to fail, so the totals cannot drift from the
// votes the way the old best-effort HINCRBY could, and the previous vote is
// read inside the script, so two racing clicks cannot both count.
//
// Reports failure rather than throwing, like every write here: the viewer
// clicked and is owed an answer. A failure almost always means nothing was
// written; the exception is a reply lost after Redis ran the script, where
// the vote stands and the viewer's next click lands on the stored state.
export async function recordRating(email, videoId, vote) {
  const id = String(videoId || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    const changed = await redis.eval(VOTE_SCRIPT, [ratingsKey(email), COUNTS], [id, vote || '']);
    return { ok: true, vote: vote || null, changed: Number(changed) === 1 };
  } catch (e) {
    console.error('Could not save a rating:', e);
    return { ok: false, error: vote ? 'Could not save your rating' : 'Could not change your rating' };
  }
}

export async function getRatingCounts() {
  try {
    return (await redis.hgetall(COUNTS)) || {};
  } catch (e) {
    console.error('Could not read the rating counts:', e);
    return {};
  }
}

// Every viewer's ratings hash, by SCAN. Used only by the admin maintenance
// sweep — an occasional action, not a request path.
export async function scanRatingKeys() {
  const pattern = `${k('ratings:')}*`;
  let cursor = '0';
  const keys = [];
  do {
    const [next, batch] = await redis.scan(cursor, { match: pattern, count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

// Rebuilds the counters from the votes and replaces them, in one script.
// Corrects drift left by the old two-write path — and, in this repo, by the
// orphaned-viewer sweep in lib/maintenance.js, which deletes a removed
// viewer's whole ratings hash and has no way to take their votes back out of
// the totals. /api/admin/maintenance runs this straight after that sweep.
// THROWS on failure: its only caller has to say the recount did not happen.
export async function recountRatings() {
  const keys = await scanRatingKeys();
  const [votes, fields] = await redis.eval(RECOUNT_SCRIPT, [COUNTS, ...keys], []);
  return { viewers: keys.length, votes: Number(votes) || 0, fields: Number(fields) || 0 };
}

// Called when a video is deleted, so the counters never hold totals for a
// video that no longer exists and a recycled bunny.net id cannot inherit
// another video's score. The per-viewer votes are left alone: they are keyed
// by an id that no longer resolves, so they read as nothing, and rewriting
// every viewer's hash on a delete would be a scan this repo does not do here.
export async function clearVideoRatingCounts(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return;
  try {
    await redis.hdel(COUNTS, `${id}:up`, `${id}:down`);
  } catch (e) {
    console.error('Could not clear rating counters:', e);
  }
}
