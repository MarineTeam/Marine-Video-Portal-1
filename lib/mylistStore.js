import { redis, k } from './redis';
import { normalizeList } from './mylist';

// Redis half of the per-viewer saved queue. SERVER ONLY — never import this
// from a component; see the note at the top of lib/mylist.js.
//
//   pvp:mylist:{email}  videoId -> epoch ms when it was saved
//
// Keyed by email exactly like pvp:progress:{email}, and deliberately a
// SEPARATE key rather than a field beside progress: progress is derived from
// playback and written on a timer, this is written only by an explicit click,
// and merging them would make a saved list vulnerable to a progress write
// racing it.
//
// Like progress, this key is per-viewer and so accumulates orphans when a
// viewer is removed — lib/maintenance.js sweeps both, which is why the sweeper
// is no longer named after progress alone.

const listKey = (email) => k(`mylist:${String(email || '').trim().toLowerCase()}`);

export async function getMyList(email) {
  if (!String(email || '').trim()) return {};
  try {
    return (await redis.hgetall(listKey(email))) || {};
  } catch (e) {
    // A saved row is a convenience over a library that works without it, so an
    // unreadable value degrades to "nothing saved" rather than breaking the page.
    console.error('Could not read a saved list:', e);
    return {};
  }
}

export async function getMyListEntries(email) {
  return normalizeList(await getMyList(email));
}

export async function saveToMyList(email, videoId) {
  const id = String(videoId || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis.hset(listKey(email), { [id]: Date.now() });
    return { ok: true, saved: true };
  } catch (e) {
    // Unlike a read, a write failure is worth reporting: the viewer clicked
    // and is owed an answer.
    console.error('Could not save to a list:', e);
    return { ok: false, error: 'Could not save to your list' };
  }
}

export async function removeFromMyList(email, videoId) {
  const id = String(videoId || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis.hdel(listKey(email), id);
    return { ok: true, saved: false };
  } catch (e) {
    console.error('Could not change a list:', e);
    return { ok: false, error: 'Could not change your list' };
  }
}
