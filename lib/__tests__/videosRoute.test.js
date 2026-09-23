import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/videos.js — search, and the two ways it used to fall over.
//
// Narrow on purpose (see apiGates.test.js for the house rule on route tests):
// the gate is covered elsewhere; this pins that a passage search finds a
// passage however it was written, that it runs over the ALREADY-FILTERED
// list (so it can never surface a video outside the viewer's groups), and
// that a repeated query parameter is no search rather than a 500.

const state = vi.hoisted(() => ({
  videos: [],
  meta: {},
  allowedGuids: null,
}));

vi.mock('@auth0/nextjs-auth0', () => ({
  getSession: async () => ({ user: { email: 'viewer@example.com' } }),
}));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    sismember: async () => 1,
    hset: async () => 1,
    get: async () => null,
  },
}));
vi.mock('../ratelimit', () => ({ allow: async () => true, callerId: () => 'test' }));
vi.mock('../roles', () => ({ isStaffUser: async () => false }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));
vi.mock('../verification', () => ({
  isVerified: async () => true,
  recordObservation: async () => {},
}));
vi.mock('../bunny', () => ({
  listVideos: async () => state.videos,
  getThumbnailUrl: () => null,
}));
vi.mock('../order', () => ({ getOrder: async () => [], applyOrder: (v) => v }));
vi.mock('../groups', () => ({
  resolveAccess: async () => ({}),
  filterVideos: (_access, videos) =>
    state.allowedGuids ? videos.filter((v) => state.allowedGuids.includes(v.guid)) : videos,
}));
vi.mock('../schedule', () => ({ listSchedules: async () => ({}), filterScheduled: (_s, v) => v }));
vi.mock('../videoMetaStore', () => ({ listVideoMeta: async () => state.meta }));
vi.mock('../captionsStore', () => ({ listTranscriptText: async () => ({}) }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/videos')).default;

async function search(query) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await route({ method: 'GET', query, headers: {} }, res);
  return res;
}
const ids = (res) => res.body.videos.map((v) => v.id);

beforeEach(() => {
  state.videos = [
    { guid: 'a', title: 'Humility', status: 4 },
    { guid: 'b', title: 'Joy — Php 4:4', status: 4 },
    { guid: 'c', title: 'Harbour tour', status: 4 },
  ];
  state.meta = { a: { notes: 'Text: Phil 1:27-2:11', chapters: [] } };
  state.allowedGuids = null;
});

describe('passage search', () => {
  it('finds a passage in the NOTES in another spelling, by overlap', async () => {
    expect(ids(await search({ q: 'Philippians 2' }))).toEqual(['a']);
  });

  it('finds a passage in the TITLE in another spelling', async () => {
    expect(ids(await search({ q: 'Philippians 4' }))).toEqual(['b']);
  });

  it('finds the whole book when it is spelled out', async () => {
    expect(ids(await search({ q: 'philippians' }))).toEqual(['a', 'b']);
  });

  it('never surfaces a video the group filter removed', async () => {
    state.allowedGuids = ['b', 'c'];
    expect(ids(await search({ q: 'Philippians 2' }))).toEqual([]);
    expect(ids(await search({ q: 'Philippians' }))).toEqual(['b']);
  });
});

describe('malformed query parameters', () => {
  it('treats a repeated ?q= as no search, not a 500', async () => {
    const res = await search({ q: ['phil', 'john'] });
    expect(res.statusCode).toBe(200);
  });

  it('treats a repeated ?collection= as no filter, not a 500', async () => {
    const res = await search({ collection: ['x', 'y'] });
    expect(res.statusCode).toBe(200);
  });
});

describe('?index=books — Browse by book', () => {
  it('counts videos per book from titles and notes, in Bible order', async () => {
    state.videos.push({ guid: 'd', title: 'Genesis 1', status: 4 });
    const res = await search({ index: 'books' });
    expect(res.body).toEqual({
      books: [
        { book: 'Genesis', count: 1 },
        { book: 'Philippians', count: 2 },
      ],
    });
  });

  // A count is information: 'Philippians (2)' says two videos exist.
  it('counts ONLY what the group filter left — a hidden video adds nothing', async () => {
    state.allowedGuids = ['b', 'c'];
    expect((await search({ index: 'books' })).body).toEqual({
      books: [{ book: 'Philippians', count: 1 }],
    });
  });
});

describe('word stems', () => {
  beforeEach(() => {
    state.videos = [
      { guid: 'a', title: 'Baptized in the Jordan', status: 4 },
      { guid: 'b', title: 'Part 2', status: 4 },
      { guid: 'c', title: 'Harbour tour', status: 4 },
    ];
    state.meta = {
      a: { notes: 'Forgiveness and grace', chapters: [] },
      b: { notes: 'Philippians 4:10-20', chapters: [] },
    };
  });

  it('finds another form of a word in title or notes', async () => {
    expect(ids(await search({ q: 'baptism' }))).toEqual(['a']);
    expect(ids(await search({ q: 'forgiving grace' }))).toEqual(['a']);
  });

  it('does not let stems widen a PASSAGE query to the whole book', async () => {
    // Every word of 'philippians 2' is in video b; the passage is not.
    expect(ids(await search({ q: 'Philippians 2' }))).toEqual([]);
  });

  it('never surfaces a video the group filter removed', async () => {
    state.allowedGuids = ['b', 'c'];
    expect(ids(await search({ q: 'baptism' }))).toEqual([]);
  });
});
