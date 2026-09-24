import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/admin/videos.js DELETE — that a deleted video leaves no group
// grant behind. Uploads can now tick a video into groups, and cancelling an
// upload deletes its half-made video, so without this every cancelled upload
// would leave a stale id in the groups it was ticked into.

const state = vi.hoisted(() => ({
  deleteFails: [],
  pruned: [],
  transcriptsCleared: [],
  commentsCleared: [],
  schedulesCleared: [],
  watermarkCalls: [],
}));

vi.mock('../roles', () => ({
  requireCapability: async () => ({ email: 'admin@example.com', role: 'admin', session: {} }),
}));
vi.mock('../bunny', () => ({
  deleteVideo: async (id) => {
    if (state.deleteFails.includes(id)) throw new Error('bunny said no');
  },
  updateVideoTitle: async () => {},
  setVideoCollection: async () => {},
  getThumbnailUrl: () => null,
}));
vi.mock('../order', () => ({ getOrder: async () => [], setOrder: async () => {}, applyOrder: (v) => v }));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../push', () => ({ maybeAnnounceReady: async () => {} }));
vi.mock('../watermark', () => ({
  listVideoWatermarkModes: async () => ({}),
  setVideoWatermarkMode: async (id, mode) => state.watermarkCalls.push([id, mode]),
}));
vi.mock('../schedule', () => ({
  listSchedules: async () => ({}),
  setSchedule: async () => {},
  scheduleState: () => null,
  clearSchedule: async (id) => state.schedulesCleared.push(id),
}));
vi.mock('../videoMetaStore', () => ({ listVideoMeta: async () => ({}), setVideoMeta: async () => {}, clearVideoMeta: async () => {} }));
vi.mock('../ratingsStore', () => ({ clearVideoRatingCounts: async () => {}, getRatingCounts: async () => ({}) }));
vi.mock('../groups', () => ({ pruneVideosFromGroups: async (ids) => state.pruned.push(ids) }));
vi.mock('../publicVideos', () => ({ listPublicVideos: async () => [], clearPublicVideo: async () => {} }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => {} }));
vi.mock('../commentsStore', () => ({ clearComments: async (id) => state.commentsCleared.push(id) }));
vi.mock('../captionsStore', () => ({
  clearTranscript: async (id) => {
    state.transcriptsCleared.push(id);
    return { ok: true, cues: 0 };
  },
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/admin/videos')).default;

async function del(body) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await route({ method: 'DELETE', body, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  state.deleteFails = [];
  state.pruned = [];
  state.transcriptsCleared = [];
  state.commentsCleared = [];
  state.schedulesCleared = [];
  state.watermarkCalls = [];
});

describe('deleting videos clears their group grants', () => {
  it('prunes a deleted video from every group', async () => {
    await del({ id: 'v1' });
    expect(state.pruned).toEqual([['v1']]);
  });

  it('prunes only the videos bunny actually deleted', async () => {
    state.deleteFails = ['v2'];
    await del({ ids: ['v1', 'v2', 'v3'] });
    expect(state.pruned).toEqual([['v1', 'v3']]);
  });

  it('prunes nothing when nothing was deleted', async () => {
    state.deleteFails = ['v1'];
    await del({ id: 'v1' });
    expect(state.pruned).toEqual([]);
  });
});

describe('deleting videos clears their transcripts', () => {
  it('clears the transcript — every language — of each video bunny deleted, and only those', async () => {
    state.deleteFails = ['v2'];
    await del({ ids: ['v1', 'v2', 'v3'] });
    expect(state.transcriptsCleared).toEqual(['v1', 'v3']);
    expect(state.commentsCleared).toEqual(['v1', 'v3']);
  });
});

describe('deleting videos clears their schedule and watermark setting', () => {
  it('clears both for each video bunny deleted, and only those', async () => {
    state.deleteFails = ['v2'];
    await del({ ids: ['v1', 'v2', 'v3'] });
    expect(state.schedulesCleared).toEqual(['v1', 'v3']);
    // 'default' removes the override; any other mode would SET one.
    expect(state.watermarkCalls).toEqual([
      ['v1', 'default'],
      ['v3', 'default'],
    ]);
  });
});
