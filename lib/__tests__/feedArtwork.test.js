import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/feed/[token]/[file].js — per-episode podcast artwork, reachable
// without a session. A stable address rather than a signed URL in the feed,
// because apps cache art keyed on the URL. Every check the feed makes is
// re-made per fetch, every refusal is the same bare 404, and nothing is
// signed for a request that is going to be refused.

const VID = '12345678-abcd-4ef0-9abc-1234567890ab';

const state = vi.hoisted(() => ({
  enabled: true,
  email: 'viewer@example.com',
  approved: true,
  staff: false,
  video: null,
  bunnyThrows: false,
  canSee: true,
  visible: true,
  scheduleThrows: false,
  signed: [],
}));

vi.mock('../podcastConfig', () => ({ podcastFeedEnabled: () => state.enabled }));
vi.mock('../feedTokens', () => ({
  resolveToken: async (t) => (t === 'tok-valid-aaaaaaaaaaaa' ? state.email : null),
}));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: { sismember: async () => (state.approved ? 1 : 0) },
}));
vi.mock('../roles', () => ({ isStaffUser: async () => state.staff }));
vi.mock('../ratelimit', () => ({ allow: async () => true }));
vi.mock('../bunny', () => ({
  getVideoById: async () => {
    if (state.bunnyThrows) throw new Error('bunny down');
    return state.video;
  },
  getThumbnailUrl: (video, ttl) => {
    state.signed.push([video.thumbnailFileName, ttl]);
    return `https://vz.b-cdn.net/${video.guid}/${video.thumbnailFileName}?token=sig&expires=1`;
  },
}));
vi.mock('../groups', () => ({ resolveAccess: async () => ({ groupIds: ['grp-1'] }), canSeeVideo: () => state.canSee }));
vi.mock('../schedule', () => ({
  getSchedule: async () => {
    if (state.scheduleThrows) throw new Error('redis down');
    return null;
  },
  isVisibleFor: (_entry, groupIds) => {
    state.windowGroups = groupIds;
    return state.visible;
  },
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/feed/[token]/[file]')).default;

async function art(file = `${VID}.jpg`, token = 'tok-valid-aaaaaaaaaaaa') {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (n, v) => { res.headers[n.toLowerCase()] = v; return res; };
  res.end = () => res;
  await route({ method: 'GET', query: { token, file }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  Object.assign(state, {
    enabled: true,
    email: 'viewer@example.com',
    approved: true,
    staff: false,
    video: { guid: VID, thumbnailFileName: 'thumbnail_9f.jpg' },
    bunnyThrows: false,
    canSee: true,
    visible: true,
    scheduleThrows: false,
    signed: [],
  });
});

describe('episode artwork', () => {
  it('redirects to a SHORT-LIVED signed custom thumbnail', async () => {
    const res = await art();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/${VID}/thumbnail_9f.jpg`);
    expect(state.signed[0][1]).toBeLessThanOrEqual(15 * 60);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  const refusals = [
    ['the feature is off', () => { state.enabled = false; }],
    ['the token is unknown', () => { state.email = null; }],
    ['the person is neither approved nor staff', () => { state.approved = false; }],
    ['bunny cannot find the video', () => { state.video = null; }],
    ['bunny fails', () => { state.bunnyThrows = true; }],
    ['the video is outside their groups', () => { state.canSee = false; }],
    ['the video is outside its publish window', () => { state.visible = false; }],
    ['the schedule cannot be read — fails CLOSED', () => { state.scheduleThrows = true; }],
  ];
  for (const [why, arrange] of refusals) {
    it(`404s, signing nothing, when ${why}`, async () => {
      arrange();
      const res = await art();
      expect(res.statusCode).toBe(404);
      expect(state.signed).toEqual([]);
    });
  }

  it("checks the publish window with the viewer's groups", async () => {
    state.windowGroups = undefined;
    await art();
    expect(state.windowGroups).toEqual(['grp-1']);
  });

  it('lets staff see art outside the publish window, as the feed does', async () => {
    state.visible = false;
    state.staff = true;
    expect((await art()).statusCode).toBe(302);
  });

  it('refuses anything but <videoId>.jpg', async () => {
    for (const file of [`${VID}.mp4`, '../x.jpg', 'abc.jpg', [`${VID}.jpg`]]) {
      expect((await art(file)).statusCode, String(file)).toBe(404);
    }
  });

  it('refuses a thumbnail file name that is not a plain file name', async () => {
    for (const name of ['../../secret.jpg', 'a/b.jpg', 'x.svg']) {
      state.video.thumbnailFileName = name;
      expect((await art()).statusCode, name).toBe(404);
    }
    expect(state.signed).toEqual([]);
  });
});
