// The WHOLE video library, and single videos looked up directly.
//
// bunny hands videos over at most 100 a page. Every list in this portal used
// to ask for page 1 and stop, silently: the homepage, search, Browse by book,
// the admin Videos tab, Analytics and the podcast feed all saw the newest 100
// videos and nothing older — and the watch page, ratings, My List, transcripts
// and the public page looked a video up IN that list, so the 101st-newest
// video answered "Video not found." even from its own link.
//
// Lists now read every page through listAllVideos(); one video is looked up
// with findVideo(), one request whatever the size of the library.
//
// Bounded, and honest about the bound: past MAX_LIBRARY_PAGES pages the list
// comes back with truncated: true, for the caller to say so rather than
// present a partial library as the whole one.
//
// Pages after the first are fetched in parallel — the first page carries the
// total, so the rest are known up front. A video uploaded between two page
// reads can push another across a page boundary, so results are de-duplicated
// by guid; the next load sees the library settled.
import { getVideoById, isVideoId, listVideosPage } from './bunny';

export const LIBRARY_PAGE_SIZE = 100;
export const MAX_LIBRARY_PAGES = 10;
// The most videos a whole-library read returns. Also the most a saved custom
// order may hold (pages/api/admin/order.js), since the Videos tab saves the
// order of exactly the list this returns.
export const MAX_LIBRARY_VIDEOS = LIBRARY_PAGE_SIZE * MAX_LIBRARY_PAGES;

const itemsOf = (data) => (Array.isArray(data?.items) ? data.items : []);

function unique(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    if (!v?.guid || seen.has(v.guid)) return false;
    seen.add(v.guid);
    return true;
  });
}

// Returns { videos, truncated, total } — `total` is bunny's count of the whole
// library when it gave one, else how many were read. Throws if the FIRST page
// cannot be read — there is no library to answer with — and likewise if a
// later page fails, because a library quietly missing a page is the failure
// this exists to end.
export async function listAllVideos() {
  const first = await listVideosPage({ page: 1, itemsPerPage: LIBRARY_PAGE_SIZE });
  const all = [...itemsOf(first)];
  const total = Number(first?.totalItems) || 0;

  if (total > 0) {
    // Pages are counted in the size bunny actually served, not the size asked
    // for: itemsPerPage is a request, not a promise (see the bunny reference
    // skill), and counting in the wrong size would skip whole pages.
    const perPage = all.length || LIBRARY_PAGE_SIZE;
    const needed = Math.ceil(total / perPage);
    const pages = Math.min(needed, MAX_LIBRARY_PAGES);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
        listVideosPage({ page: i + 2, itemsPerPage: LIBRARY_PAGE_SIZE })
      )
    );
    for (const data of rest) all.push(...itemsOf(data));
    const videos = unique(all);
    return { videos, truncated: needed > MAX_LIBRARY_PAGES, total: Math.max(total, videos.length) };
  }

  // No total in the reply: walk pages until a short one arrives.
  let last = itemsOf(first);
  let page = 1;
  while (last.length === LIBRARY_PAGE_SIZE && page < MAX_LIBRARY_PAGES) {
    page += 1;
    last = itemsOf(await listVideosPage({ page, itemsPerPage: LIBRARY_PAGE_SIZE }));
    all.push(...last);
  }
  const videos = unique(all);
  return { videos, truncated: last.length === LIBRARY_PAGE_SIZE, total: videos.length };
}

// One video by id: null when the id is not a video id or bunny has no such
// video; THROWS when bunny could not be asked, so a caller can tell "not
// found" (404) from "could not look" (502) — the distinction the old
// find-in-a-list lookups made, and must keep making.
export async function findVideo(id) {
  if (!isVideoId(id)) return null;
  const video = await getVideoById(id);
  return video?.guid ? video : null;
}
