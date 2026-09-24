import { describe, it, expect, beforeEach, vi } from 'vitest';

// The routes around repeat rules and per-group windows:
//   * PUT /api/admin/videos stores the whole schedule entry, and refuses a bad
//     weekly rule or a window for a group that does not exist — with the REAL
//     lib/schedule.js validating and writing to a stand-in Redis hash;
//   * DELETE /api/admin/groups prunes the deleted group's windows;
//   * /api/videos hands the viewer's group ids to the schedule filter, so a
//     group's own window actually opens the video for its members.

const G1 = '6f1c1c9e-6d7a-4c1a-9a57-000000000001';
const state = vi.hoisted(() => ({
  hash: {},
  knownGroups: [],
  pruned: [],
  pruneFails: false,
  deleted: [],
  videos: [],
  viewerGroups: [],
}));

vi.mock('@auth0/nextjs-auth0', () => ({
  getSession: async () => ({ user: { email: 'viewer@example.com' } }),
}));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    hgetall: async (key) => (key === 'pvp:video_schedule' ? { ...state.hash } : {}),
    hget: async (_key, field) => (state.hash[field] ? JSON.parse(state.hash[field]) : null),
    hset: async (key, obj) => (key === 'pvp:video_schedule' ? Object.assign(state.hash, obj) : 1),
    hdel: async (_key, field) => {
      delete state.hash[field];
      return 1;
    },
    sismember: async () => 1,
    get: async () => null,
  },
}));
vi.mock('../roles', () => ({
  requireCapability: async () => ({ email: 'admin@example.com', role: 'admin', session: {} }),
  isStaffUser: async () => false,
}));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));
vi.mock('../bunny', () => ({
  listVideos: async () => state.videos,
  deleteVideo: async () => {},
  updateVideoTitle: async () => {},
  setVideoCollection: async () => {},
  getThumbnailUrl: () => null,
}));
vi.mock('../order', () => ({ getOrder: async () => [], setOrder: async () => {}, applyOrder: (v) => v }));
vi.mock('../push', () => ({ maybeAnnounceReady: async () => {} }));
vi.mock('../watermark', () => ({ listVideoWatermarkModes: async () => ({}), setVideoWatermarkMode: async () => {} }));
vi.mock('../videoMetaStore', () => ({ listVideoMeta: async () => ({}), setVideoMeta: async () => {}, clearVideoMeta: async () => {} }));
vi.mock('../ratingsStore', () => ({ clearVideoRatingCounts: async () => {}, getRatingCounts: async () => ({}) }));
vi.mock('../publicVideos', () => ({ listPublicVideos: async () => [], clearPublicVideo: async () => {} }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => {} }));
vi.mock('../captionsStore', () => ({
  listTranscriptText: async () => ({}),
  matchingTranslatedGuids: async () => [],
  clearTranscript: async () => ({ ok: true }),
}));
vi.mock('../ratelimit', () => ({ allow: async () => true, callerId: () => 'test' }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));
vi.mock('../verification', () => ({ isVerified: async () => true, recordObservation: async () => {} }));
vi.mock('../groups', () => ({
  listGroupIds: async () => state.knownGroups,
  pruneVideosFromGroups: async () => 0,
  deleteGroup: async (id) => {
    state.deleted.push(id);
    return { ok: true, removedMembers: 0 };
  },
  resolveAccess: async () => ({ restricted: false, groupIds: state.viewerGroups }),
  filterVideos: (_access, videos) => videos,
}));
vi.mock('../schedule', async () => ({
  ...(await vi.importActual('../schedule')),
  pruneGroupFromSchedules: async (id) => {
    if (state.pruneFails) throw new Error('redis down');
    state.pruned.push(id);
    return 1;
  },
}));

const videosAdmin = (await import('../../pages/api/admin/videos')).default;
const groupsAdmin = (await import('../../pages/api/admin/groups')).default;
const library = (await import('../../pages/api/videos')).default;

async function call(route, method, body = {}, query = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await route({ method, body, query, headers: {} }, res);
  return res;
}

const at = (iso) => Date.parse(iso);
const weekly = { days: [0, 3], start: '18:30', end: '21:00', timeZone: 'America/Los_Angeles' };
const stored = (id) => (state.hash[id] ? JSON.parse(state.hash[id]) : undefined);

beforeEach(() => {
  state.hash = {};
  state.knownGroups = [G1];
  state.pruned = [];
  state.pruneFails = false;
  state.deleted = [];
  state.videos = [];
  state.viewerGroups = [];
});

describe('PUT /api/admin/videos — saving a schedule', () => {
  it('stores the dates, the weekly rule and the group windows as one entry', async () => {
    const res = await call(videosAdmin, 'PUT', {
      id: 'vid-1',
      publishAt: at('2026-10-01T16:00:00Z'),
      expiresAt: '',
      repeat: weekly,
      groups: { [G1]: { publishAt: at('2026-09-25T16:00:00Z'), expiresAt: null } },
    });
    expect(res.statusCode).toBe(200);
    expect(stored('vid-1')).toEqual({
      publishAt: at('2026-10-01T16:00:00Z'),
      expiresAt: null,
      repeat: weekly,
      groups: { [G1]: { publishAt: at('2026-09-25T16:00:00Z'), expiresAt: null } },
    });
    expect(res.body.schedule.repeat).toEqual(weekly);
  });

  it('stores an entry that has only a weekly rule', async () => {
    await call(videosAdmin, 'PUT', { id: 'vid-1', publishAt: '', expiresAt: '', repeat: weekly });
    expect(stored('vid-1')).toEqual({ publishAt: null, expiresAt: null, repeat: weekly });
  });

  it('clears the entry when everything is empty', async () => {
    state.hash['vid-1'] = JSON.stringify({ publishAt: null, expiresAt: null, repeat: weekly });
    await call(videosAdmin, 'PUT', { id: 'vid-1', publishAt: '', expiresAt: '', repeat: null, groups: null });
    expect(stored('vid-1')).toBeUndefined();
  });

  it.each([
    [{ ...weekly, days: [] }, /at least one day/],
    [{ ...weekly, timeZone: 'Nowhere/Special' }, /time zone/],
    [{ ...weekly, end: '18:30' }, /same time/],
  ])('refuses a bad weekly rule and stores nothing (%j)', async (repeat, message) => {
    const res = await call(videosAdmin, 'PUT', { id: 'vid-1', publishAt: '', expiresAt: '', repeat });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(state.hash).toEqual({});
  });

  it('refuses a window for a group that does not exist and stores nothing', async () => {
    const res = await call(videosAdmin, 'PUT', {
      id: 'vid-1',
      publishAt: '',
      expiresAt: '',
      groups: { 'not-a-group': { publishAt: at('2026-09-25T16:00:00Z') } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no longer exists/);
    expect(state.hash).toEqual({});
  });
});

describe('DELETE /api/admin/groups', () => {
  it("prunes the deleted group's publish windows", async () => {
    const res = await call(groupsAdmin, 'DELETE', { groupId: G1 });
    expect(res.statusCode).toBe(200);
    expect(state.deleted).toEqual([G1]);
    expect(state.pruned).toEqual([G1]);
  });

  it('still reports the delete when pruning fails — the group is gone either way', async () => {
    state.pruneFails = true;
    const res = await call(groupsAdmin, 'DELETE', { groupId: G1 });
    expect(res.statusCode).toBe(200);
    expect(state.deleted).toEqual([G1]);
  });

  it('does not prune when only a member is removed', async () => {
    await call(groupsAdmin, 'DELETE', { groupId: G1, email: 'x@example.com' }).catch(() => {});
    expect(state.pruned).toEqual([]);
  });
});

describe('/api/videos — per-group windows reach the library', () => {
  beforeEach(() => {
    state.videos = [
      { guid: 'early', title: 'Early', status: 4 },
      { guid: 'plain', title: 'Plain', status: 4 },
    ];
    state.hash.early = JSON.stringify({
      publishAt: at('2099-01-01T00:00:00Z'),
      expiresAt: null,
      groups: { [G1]: { publishAt: at('2020-01-01T00:00:00Z'), expiresAt: null } },
    });
  });
  const guids = (res) => res.body.videos.map((v) => v.id);

  it("shows the video to a member of the group during the group's window", async () => {
    state.viewerGroups = [G1];
    expect(guids(await call(library, 'GET', {}, {}))).toEqual(['early', 'plain']);
  });

  it('hides it from a viewer outside the group', async () => {
    state.viewerGroups = [];
    expect(guids(await call(library, 'GET', {}, {}))).toEqual(['plain']);
  });
});
