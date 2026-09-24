import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every route that means "the library" reads all of it, and every route about
// ONE video looks it up directly — not in bunny's newest 100.
//
// Before lib/videoLibrary.js each of these asked bunny for page 1 and stopped:
// search, Browse by book, the admin Videos tab, Analytics and the podcast feed
// saw the newest 100 videos only, and the watch page, ratings, My List,
// transcripts and the public page looked a video up IN that list — so the
// 101st-newest video answered "not found" even from its own link.
//
// The REAL lib/videoLibrary.js runs here, over a mocked bunny that pages the
// way bunny does (100 a page, with a total), so these tests reach through the
// helper to the routes.

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const state = vi.hoisted(() => ({
  library: [],
  bunnyDown: false,
  byIdCalls: [],
  scope: null,
  savedOrder: null,
  saved: [],
  recorded: [],
}));

vi.mock('@auth0/nextjs-auth0', () => ({
  getSession: async () => ({ user: { email: 'viewer@example.com' } }),
}));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: { sismember: async () => 1, hset: async () => 1, get: async () => null },
}));
vi.mock('../bunny', () => ({
  listVideosPage: async ({ page = 1, itemsPerPage = 100 } = {}) => {
    if (state.bunnyDown) throw new Error('bunny down');
    const start = (page - 1) * itemsPerPage;
    return { items: state.library.slice(start, start + itemsPerPage), totalItems: state.library.length };
  },
  getVideoById: async (id) => {
    state.byIdCalls.push(id);
    if (state.bunnyDown) throw new Error('bunny down');
    return state.library.find((v) => v.guid === id) || null;
  },
  isVideoId: (value) => typeof value === 'string' && GUID_RE.test(value),
  getThumbnailUrl: () => null,
  getLibraryStatistics: async () => ({ viewsChart: {} }),
  getVideoFileUrl: (v) => `https://cdn.example/${v.guid}.mp4`,
  podcastMediaFile: () => 'play_720p.mp4',
  getEmbedUrl: (id) => `https://iframe.example/embed/${id}`,
  deleteVideo: async () => {},
  updateVideoTitle: async () => {},
  setVideoCollection: async () => {},
}));
vi.mock('../roles', () => ({
  isStaffUser: async () => false,
  requireCapability: async () => ({ email: 'admin@example.com' }),
}));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));
vi.mock('../verification', () => ({ isVerified: async () => true, recordObservation: async () => {} }));
vi.mock('../ratelimit', () => ({ allow: async () => true, callerId: () => 'test' }));
// Scope stand-in: when set, only videos in that collection are visible.
vi.mock('../groups', () => ({
  resolveAccess: async () => ({ groupIds: [] }),
  filterVideos: (_access, videos) =>
    state.scope ? videos.filter((v) => v.collectionId === state.scope) : videos,
  canSeeVideo: (_access, video) => !state.scope || video.collectionId === state.scope,
  listGroupIds: async () => [],
  pruneVideosFromGroups: async () => {},
}));
vi.mock('../schedule', () => ({
  listSchedules: async () => ({}),
  filterScheduled: (_s, videos) => videos,
  getSchedule: async () => null,
  isVisibleFor: () => true,
  isVisibleNow: () => true,
  scheduleState: () => null,
  setSchedule: async () => {},
  validateGroupWindows: () => ({}),
  validateRepeat: () => null,
}));
vi.mock('../order', () => ({
  getOrder: async () => [],
  setOrder: async (order) => {
    state.savedOrder = order;
  },
  applyOrder: (videos) => videos,
}));
vi.mock('../videoMetaStore', () => ({
  listVideoMeta: async () => ({}),
  getVideoMeta: async () => null,
  setVideoMeta: async () => {},
  clearVideoMeta: async () => {},
}));
vi.mock('../captionsStore', () => ({
  listTranscriptText: async () => ({}),
  matchingTranslatedGuids: async () => [],
  getTranscript: async () => [{ start: 0, end: 1, text: 'Grace' }],
  getTranscriptLanguages: async () => ['en'],
  clearTranscript: async () => {},
}));
vi.mock('../ratingsStore', () => ({
  getRatingCounts: async () => ({}),
  getRatings: async () => ({}),
  recordRating: async (email, id, vote) => {
    state.recorded.push([id, vote]);
    return { ok: true, vote };
  },
  clearVideoRatingCounts: async () => {},
}));
vi.mock('../mylistStore', () => ({
  getMyList: async () => ({}),
  saveToMyList: async (email, id) => {
    state.saved.push(id);
    return { ok: true };
  },
  removeFromMyList: async () => ({ ok: true }),
}));
vi.mock('../publicVideos', () => ({
  listPublicVideos: async () => [],
  clearPublicVideo: async () => {},
  isPublicVideo: async () => true,
}));
vi.mock('../push', () => ({ maybeAnnounceReady: async () => {} }));
vi.mock('../watermark', () => ({
  listVideoWatermarkModes: async () => ({}),
  setVideoWatermarkMode: async () => {},
}));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../commentsStore', () => ({ clearComments: async () => {} }));
vi.mock('../feedTokens', () => ({ resolveToken: async () => 'viewer@example.com' }));
vi.mock('../brandingStore', () => ({ getSiteName: async () => 'Grace Chapel' }));
vi.mock('../appIconStore', () => ({ getAppIconVersion: async () => null }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const videosRoute = (await import('../../pages/api/videos')).default;
const adminVideosRoute = (await import('../../pages/api/admin/videos')).default;
const analyticsRoute = (await import('../../pages/api/admin/analytics')).default;
const feedRoute = (await import('../../pages/api/feed/[token]')).default;
const orderRoute = (await import('../../pages/api/admin/order')).default;
const ratingRoute = (await import('../../pages/api/rating')).default;
const mylistRoute = (await import('../../pages/api/mylist')).default;
const transcriptRoute = (await import('../../pages/api/transcript/[id]')).default;
const { resolvePublicVideo } = await import('../publicWatch');

function mockRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.send = (body) => {
    res.body = body;
    return res;
  };
  res.end = () => res;
  res.setHeader = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  return res;
}

async function call(route, { method = 'GET', query = {}, body = {} } = {}) {
  const res = mockRes();
  await route({ method, query, body, headers: {} }, res);
  return res;
}

// Newest first, as bunny orders them: video 1 is the newest.
const makeLibrary = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    guid: guid(i + 1),
    title: `Talk ${i + 1}`,
    status: 4,
    collectionId: 'recent',
    views: 1,
    dateUploaded: new Date(Date.UTC(2026, 0, 1) - i * 86400000).toISOString(),
    ...extra(i + 1),
  }));

beforeEach(() => {
  Object.assign(state, {
    library: [],
    bunnyDown: false,
    byIdCalls: [],
    scope: null,
    savedOrder: null,
    saved: [],
    recorded: [],
  });
});

describe('/api/videos — search and filters reach the whole library', () => {
  it('finds a video far past the newest 100 by title', async () => {
    state.library = makeLibrary(250, (n) => (n === 240 ? { title: 'The Prodigal Son' } : {}));
    const res = await call(videosRoute, { query: { q: 'prodigal' } });
    expect(res.body.videos.map((v) => v.id)).toEqual([guid(240)]);
  });

  it('filters by a collection whose videos are all older than the newest 100', async () => {
    state.library = makeLibrary(160, (n) => (n > 150 ? { collectionId: 'archive' } : {}));
    const res = await call(videosRoute, { query: { collection: 'archive' } });
    expect(res.body.videos).toHaveLength(10);
    expect(res.body.videos[0].id).toBe(guid(151));
  });

  it('counts a book cited only by an older video', async () => {
    state.library = makeLibrary(150, (n) => (n === 140 ? { title: 'Ruth 1' } : {}));
    const res = await call(videosRoute, { query: { index: 'books' } });
    expect(res.body.books).toEqual([{ book: 'Ruth', count: 1 }]);
    expect(res.body.truncated).toBe(false);
  });

  it('says a search was cut when the library is past the read bound', async () => {
    state.library = makeLibrary(1050);
    const res = await call(videosRoute, { query: { q: 'talk' } });
    expect(res.body.truncated).toBe(true);
  });

  it('never calls the plain homepage truncated', async () => {
    state.library = makeLibrary(1050);
    const res = await call(videosRoute);
    expect(res.body.truncated).toBe(false);
  });
});

describe('/api/admin/videos — the Videos tab', () => {
  it('lists every video, past the first 100', async () => {
    state.library = makeLibrary(230);
    const res = await call(adminVideosRoute);
    expect(res.body).toHaveLength(230);
    expect(res.headers['X-Library-Truncated']).toBeUndefined();
  });

  it('flags a library past the read bound', async () => {
    state.library = makeLibrary(1005);
    const res = await call(adminVideosRoute);
    expect(res.body).toHaveLength(1000);
    expect(res.headers['X-Library-Truncated']).toBe('1');
  });
});

describe('/api/admin/analytics', () => {
  it('counts views and videos across the whole library', async () => {
    state.library = makeLibrary(250, (n) => (n === 240 ? { views: 999 } : {}));
    const res = await call(analyticsRoute);
    expect(res.body.videoCount).toBe(250);
    expect(res.body.totalViews).toBe(249 + 999);
    expect(res.body.topVideos[0].id).toBe(guid(240));
    expect(res.body.truncated).toBe(false);
  });

  it('reports the real total when it can only read part of the library', async () => {
    state.library = makeLibrary(1200);
    const res = await call(analyticsRoute);
    expect(res.body.videoCount).toBe(1200);
    expect(res.body.covered).toBe(1000);
    expect(res.body.truncated).toBe(true);
  });
});

describe('/api/feed/[token]', () => {
  it('gives a group its older collection instead of an empty feed', async () => {
    state.library = makeLibrary(160, (n) => (n > 150 ? { collectionId: 'archive' } : {}));
    state.scope = 'archive';
    const res = await call(feedRoute, { query: { token: 'tok' } });
    expect(res.statusCode).toBe(200);
    expect((String(res.body).match(/<item>/g) || []).length).toBe(10);
    expect(String(res.body)).toContain(guid(151));
  });

  it('carries at most 100 episodes, chosen after the filters', async () => {
    state.library = makeLibrary(300);
    const res = await call(feedRoute, { query: { token: 'tok' } });
    expect((String(res.body).match(/<item>/g) || []).length).toBe(100);
  });
});

describe('/api/admin/order', () => {
  it('accepts the order of a library larger than 100', async () => {
    const order = makeLibrary(800).map((v) => v.guid);
    const res = await call(orderRoute, { method: 'POST', body: { order } });
    expect(res.statusCode).toBe(200);
    expect(state.savedOrder).toHaveLength(800);
  });

  it('refuses an order longer than the library bound, or holding a non-id', async () => {
    const tooLong = makeLibrary(1001).map((v) => v.guid);
    expect((await call(orderRoute, { method: 'POST', body: { order: tooLong } })).statusCode).toBe(400);
    expect((await call(orderRoute, { method: 'POST', body: { order: [guid(1), { x: 1 }] } })).statusCode).toBe(400);
    expect(state.savedOrder).toBe(null);
  });
});

describe('one video, looked up directly', () => {
  beforeEach(() => {
    state.library = makeLibrary(250);
  });

  it('rates a video older than the newest 100', async () => {
    const res = await call(ratingRoute, { method: 'POST', body: { videoId: guid(240), vote: 'up' } });
    expect(res.statusCode).toBe(200);
    expect(state.recorded).toEqual([[guid(240), 'up']]);
  });

  it('saves a video older than the newest 100 to My List', async () => {
    const res = await call(mylistRoute, { method: 'POST', body: { videoId: guid(240) } });
    expect(res.statusCode).toBe(200);
    expect(state.saved).toEqual([guid(240)]);
  });

  it('serves the transcript of a video older than the newest 100', async () => {
    const res = await call(transcriptRoute, { query: { id: guid(240) } });
    expect(res.statusCode).toBe(200);
  });

  it('opens the public page of a video older than the newest 100', async () => {
    const out = await resolvePublicVideo({ headers: {} }, guid(240));
    expect(out.error).toBeUndefined();
    expect(out.embedUrl).toContain(guid(240));
  });

  it('answers 404 for a malformed id without asking bunny', async () => {
    const res = await call(ratingRoute, { method: 'POST', body: { videoId: 'not-a-guid', vote: 'up' } });
    expect(res.statusCode).toBe(404);
    expect(state.byIdCalls).toEqual([]);
  });

  it('answers 404 for an id bunny does not have', async () => {
    const res = await call(mylistRoute, { method: 'POST', body: { videoId: guid(999) } });
    expect(res.statusCode).toBe(404);
    expect(state.saved).toEqual([]);
  });

  it('answers 502, not 404, when bunny cannot be asked', async () => {
    state.bunnyDown = true;
    const rating = await call(ratingRoute, { method: 'POST', body: { videoId: guid(240), vote: 'up' } });
    const transcript = await call(transcriptRoute, { query: { id: guid(240) } });
    expect(rating.statusCode).toBe(502);
    expect(transcript.statusCode).toBe(502);
  });
});
