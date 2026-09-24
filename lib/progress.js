// Rules for per-viewer playback progress (k(`progress:${email}`)), with no Redis.
//
// The player saves a position every few seconds. Before these rules the route
// wrote whatever it was sent: any value as the video id (not even required to
// be text), a title of any length, and no bound on how many videos one viewer
// could record. The flood-guard rate limit slowed that down but did not bound
// it. Now:
//
//   * the id must be a bunny video id (isVideoId in lib/bunny.js);
//   * the title is text, at most MAX_TITLE_LENGTH characters;
//   * the hash holds at most MAX_PROGRESS_ENTRIES videos. A save for a NEW
//     video at the cap drops the least recently watched entries first
//     (progressToEvict), so resume keeps working for what someone is watching
//     now — refusing instead would quietly break it after enough years.

// Matches the whole-library read bound (lib/videoLibrary.js MAX_LIBRARY_VIDEOS):
// nobody can be part-way through more videos than the library holds.
export const MAX_PROGRESS_ENTRIES = 1000;
export const MAX_TITLE_LENGTH = 200;

// The title stored beside a position — only ever text, and bounded.
export function progressTitle(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TITLE_LENGTH) : '';
}

// The ids to drop from `all` (videoId -> { seconds, duration, title, at }) so
// that one more entry fits under `max`: the least recently updated first, and
// an entry with no readable time counts as the oldest of all. `at` is epoch
// milliseconds; entries may arrive as JSON text.
export function progressToEvict(all, max = MAX_PROGRESS_ENTRIES) {
  const entries = Object.entries(all || {});
  const excess = entries.length - (max - 1);
  if (excess <= 0) return [];
  const when = (raw) => {
    let entry = raw;
    if (typeof entry === 'string') {
      try {
        entry = JSON.parse(entry);
      } catch {
        entry = null;
      }
    }
    const at = entry?.at;
    return typeof at === 'number' && Number.isFinite(at) ? at : -Infinity;
  };
  return entries
    .sort(([idA, a], [idB, b]) => when(a) - when(b) || (idA < idB ? -1 : 1))
    .slice(0, excess)
    .map(([id]) => id);
}
