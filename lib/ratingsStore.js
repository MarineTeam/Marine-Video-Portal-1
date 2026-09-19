import { redis, k } from './redis';
import { normalizeRatings } from './ratings';

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

export async function setRating(email, videoId, vote) {
  const id = String(videoId || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis.hset(ratingsKey(email), { [id]: vote });
    return { ok: true, vote };
  } catch (e) {
    // Unlike a read, a write failure is worth reporting: the viewer clicked
    // and is owed an answer.
    console.error('Could not save a rating:', e);
    return { ok: false, error: 'Could not save your rating' };
  }
}

export async function clearRating(email, videoId) {
  const id = String(videoId || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis.hdel(ratingsKey(email), id);
    return { ok: true, vote: null };
  } catch (e) {
    console.error('Could not clear a rating:', e);
    return { ok: false, error: 'Could not change your rating' };
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

// Applies the deltas from voteDelta(). BEST-EFFORT AND LAST: the viewer's own
// vote is the authoritative write and has already succeeded by the time this
// runs, so a counter failure costs an admin an accurate total and costs the
// viewer nothing. A counter can therefore drift by one against the votes;
// lib/ratings.js clamps a negative back to zero, and the drift is recorded in
// FEATURES.md rather than pretended away.
export async function applyRatingCounts(deltas) {
  for (const [field, delta] of Object.entries(deltas || {})) {
    if (!field || !delta) continue;
    try {
      await redis.hincrby(COUNTS, field, delta);
    } catch (e) {
      console.error('Could not update a rating counter:', e);
    }
  }
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
