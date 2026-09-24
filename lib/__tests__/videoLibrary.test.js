// lib/videoLibrary.js — the whole library, not bunny's first page of it, and
// one video looked up directly.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let library = [];
let withTotal = true;
let failPage = null;
let pagesAsked = [];
// When set, bunny serves this many per page whatever was asked for.
let servedPerPage = null;
// When set, a video is inserted at the front of the library after page 1 is
// read — an upload landing between two page reads.
let uploadAfterFirstPage = null;

let byId = null;
let byIdCalls = [];

vi.mock('../bunny', () => ({
  isVideoId: (value) =>
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  getVideoById: async (id) => {
    byIdCalls.push(id);
    return byId(id);
  },
  listVideosPage: async ({ page, itemsPerPage: perPage }) => {
    pagesAsked.push(page);
    if (page === failPage) throw new Error('bunny down');
    if (page === 2 && uploadAfterFirstPage) {
      library = [uploadAfterFirstPage, ...library];
      uploadAfterFirstPage = null;
    }
    const size = servedPerPage || perPage;
    const start = (page - 1) * size;
    const items = library.slice(start, start + size);
    return withTotal ? { items, totalItems: library.length } : { items };
  },
}));

const { listAllVideos, findVideo, MAX_LIBRARY_VIDEOS, LIBRARY_PAGE_SIZE, MAX_LIBRARY_PAGES } =
  await import('../videoLibrary');

const makeLibrary = (n) => Array.from({ length: n }, (_, i) => ({ guid: `v${i + 1}` }));

beforeEach(() => {
  library = [];
  withTotal = true;
  failPage = null;
  pagesAsked = [];
  servedPerPage = null;
  uploadAfterFirstPage = null;
  byId = async () => null;
  byIdCalls = [];
});

describe('listAllVideos', () => {
  it('bounds a whole-library read at 1,000 videos in pages of 100', () => {
    expect(LIBRARY_PAGE_SIZE).toBe(100);
    expect(MAX_LIBRARY_PAGES).toBe(10);
    expect(MAX_LIBRARY_VIDEOS).toBe(1000);
  });

  it('reads one page for a small library', async () => {
    library = makeLibrary(40);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(40);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(40);
    expect(pagesAsked).toEqual([1]);
  });

  it('reads every page of a library past 100 — the 101st video is there', async () => {
    library = makeLibrary(250);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(250);
    expect(out.videos.map((v) => v.guid)).toContain('v101');
    expect(out.videos.map((v) => v.guid)).toContain('v250');
    expect(out.truncated).toBe(false);
    expect(pagesAsked.sort()).toEqual([1, 2, 3]);
  });

  it('stops at the bound and says so, with the real total', async () => {
    library = makeLibrary(1234);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(1000);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(1234);
    expect(Math.max(...pagesAsked)).toBe(10);
  });

  it('a library of exactly 1,000 is complete, not truncated', async () => {
    library = makeLibrary(1000);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(1000);
    expect(out.truncated).toBe(false);
  });

  it('walks pages until a short one when bunny gives no total', async () => {
    withTotal = false;
    library = makeLibrary(230);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(230);
    expect(out.truncated).toBe(false);
    expect(pagesAsked).toEqual([1, 2, 3]);
  });

  it('without a total, a full last page at the bound is reported as truncated', async () => {
    withTotal = false;
    library = makeLibrary(1500);
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(1000);
    expect(out.truncated).toBe(true);
  });

  it('never lists a video twice when an upload shifts one across a page boundary', async () => {
    library = makeLibrary(150);
    uploadAfterFirstPage = { guid: 'new' };
    const out = await listAllVideos();
    const guids = out.videos.map((v) => v.guid);
    expect(new Set(guids).size).toBe(guids.length);
    // v100 was the last of page 1 and the first of page 2 after the upload.
    expect(guids.filter((g) => g === 'v100')).toHaveLength(1);
  });

  it('counts pages in the size bunny served, when it serves fewer than asked', async () => {
    library = makeLibrary(230);
    servedPerPage = 50;
    const out = await listAllVideos();
    expect(out.videos).toHaveLength(230);
    expect(out.truncated).toBe(false);
    expect(Math.max(...pagesAsked)).toBe(5);
  });

  it('fails rather than answer with a page missing', async () => {
    library = makeLibrary(250);
    failPage = 2;
    await expect(listAllVideos()).rejects.toThrow('bunny down');
  });
});

describe('findVideo', () => {
  const GUID = '0a1b2c3d-0000-4000-8000-000000000001';

  it('looks a video up directly, one request', async () => {
    byId = async (id) => ({ guid: id, title: 'Sunday' });
    expect(await findVideo(GUID)).toEqual({ guid: GUID, title: 'Sunday' });
    expect(byIdCalls).toEqual([GUID]);
    expect(pagesAsked).toEqual([]);
  });

  it('answers null for a malformed id without asking bunny', async () => {
    for (const bad of ['not-a-guid', '', null, undefined, ['x'], 5, `${GUID}/../x`]) {
      expect(await findVideo(bad)).toBe(null);
    }
    expect(byIdCalls).toEqual([]);
  });

  it('answers null for an id bunny does not have', async () => {
    byId = async () => null;
    expect(await findVideo(GUID)).toBe(null);
  });

  it('answers null for a reply that is not a video', async () => {
    byId = async () => ({ title: 'no guid' });
    expect(await findVideo(GUID)).toBe(null);
  });

  it('throws when bunny cannot be asked, so a caller can answer 502 rather than 404', async () => {
    byId = async () => {
      throw new Error('bunny down');
    };
    await expect(findVideo(GUID)).rejects.toThrow('bunny down');
  });
});
