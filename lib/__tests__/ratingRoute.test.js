import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/rating.js — the gate, and that a vote reaches storage as ONE call.
//
// Rating is gated exactly like watching (pages/watch/video/[id].js), including
// the verified-email check that only this repo has. A successful write is
// itself an answer to "does this id exist?", so each gate test asserts that
// nothing was recorded. The script's arithmetic is proved on a real Redis in
// ratingScripts.test.js and ratingsStore.redis.test.js.

const state = vi.hoisted(() => ({
  session: null,
  approved: true,
  staff: false,
  geo: true,
  verified: true,
  canSee: true,
  visible: true,
  allowed: true,
  videos: [{ guid: 'vid-1' }],
  stored: {},
  recordFails: false,
  recordRating: null,
}));

vi.mock('@auth0/nextjs-auth0', () => ({ getSession: async () => state.session }));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: { sismember: async () => (state.approved ? 1 : 0) },
}));
vi.mock('../roles', () => ({ isStaffUser: async () => state.staff }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => state.geo }));
vi.mock('../verification', () => ({ isVerified: async () => state.verified }));
vi.mock('../groups', () => ({
  resolveAccess: async () => ({ groupIds: ['grp-1'] }),
  canSeeVideo: () => state.canSee,
}));
vi.mock('../schedule', () => ({
  getSchedule: async () => null,
  // Records the groups it was handed: a group's own window only works if the
  // route passes the viewer's groups through.
  isVisibleFor: (_entry, groupIds) => {
    state.windowGroups = groupIds;
    return state.visible;
  },
}));
vi.mock('../ratelimit', () => ({ allow: async () => state.allowed, callerId: () => 'test' }));
vi.mock('../videoLibrary', () => ({
  findVideo: async (id) => state.videos.find((v) => v.guid === id) || null,
}));
vi.mock('../ratingsStore', () => ({
  getRatings: async () => state.stored,
  recordRating: (...args) => state.recordRating(...args),
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/rating')).default;

function mockRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; return res; };
  return res;
}

async function call({ method = 'POST', body = {}, query = {} } = {}) {
  const res = mockRes();
  await route({ method, body, query, headers: {} }, res);
  return res;
}
const post = (body) => call({ body });

beforeEach(() => {
  Object.assign(state, {
    session: { user: { email: 'Viewer@Example.com' } },
    approved: true,
    staff: false,
    geo: true,
    verified: true,
    canSee: true,
    visible: true,
    allowed: true,
    videos: [{ guid: 'vid-1' }],
    stored: {},
    recordFails: false,
  });
  state.recordRating = vi.fn(async (email, id, vote) => {
    if (state.recordFails) return { ok: false, error: 'Could not save your rating' };
    if (vote) state.stored[id] = vote;
    else delete state.stored[id];
    return { ok: true, vote, changed: true };
  });
});

describe('who may rate', () => {
  it('lets an approved, verified viewer rate', async () => {
    const res = await post({ videoId: 'vid-1', vote: 'up' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, vote: 'up' });
  });

  const refusals = [
    ['an anonymous caller', () => { state.session = null; }, 401],
    ['a caller neither approved nor staff', () => { state.approved = false; }, 403],
    ['a blocked region', () => { state.geo = false; }, 403],
    ['an UNVERIFIED email — the check sibling repos do not have', () => { state.verified = false; }, 403],
    ['a video outside the viewer’s groups, as 404', () => { state.canSee = false; }, 404],
    ['a video outside its publish window, as 404', () => { state.visible = false; }, 404],
    ['an id bunny does not have, as 404', () => { state.videos = []; }, 404],
    ['a caller over the rate limit', () => { state.allowed = false; }, 429],
  ];
  for (const [who, arrange, status] of refusals) {
    it(`refuses ${who}, and records nothing`, async () => {
      arrange();
      const res = await post({ videoId: 'vid-1', vote: 'up' });
      expect(res.statusCode).toBe(status);
      expect(state.recordRating).not.toHaveBeenCalled();
    });
  }

  it("checks the publish window with the viewer's groups", async () => {
    state.windowGroups = undefined;
    await post({ videoId: 'vid-1', vote: 'up' });
    expect(state.windowGroups).toEqual(['grp-1']);
  });

  it('lets staff rate outside the publish window', async () => {
    state.visible = false;
    state.staff = true;
    expect((await post({ videoId: 'vid-1', vote: 'up' })).statusCode).toBe(200);
  });

  it('takes no email parameter — the session decides whose rating this is', async () => {
    await post({ videoId: 'vid-1', vote: 'up', email: 'someone@else.com' });
    expect(state.recordRating.mock.calls[0][0]).toBe('viewer@example.com');
  });
});

describe('voting', () => {
  it('records a vote in one call, normalized', async () => {
    await post({ videoId: 'vid-1', vote: ' DOWN ' });
    expect(state.recordRating).toHaveBeenCalledTimes(1);
    expect(state.recordRating).toHaveBeenCalledWith('viewer@example.com', 'vid-1', 'down');
  });

  // The route no longer decides "is this a repeat?" itself — that read lives
  // inside the script now, which is what stops two racing clicks both
  // counting. So a repeat is passed through, and the script answers no-op.
  it('leaves the repeat decision to the script rather than reading first', async () => {
    state.stored = { 'vid-1': 'up' };
    const res = await post({ videoId: 'vid-1', vote: 'up' });
    expect(res.body).toEqual({ ok: true, vote: 'up' });
    expect(state.recordRating).toHaveBeenCalledTimes(1);
  });

  it('clears a vote on DELETE by recording null', async () => {
    state.stored = { 'vid-1': 'down' };
    const res = await call({ method: 'DELETE', query: { videoId: 'vid-1' } });
    expect(res.body).toEqual({ ok: true, vote: null });
    expect(state.recordRating).toHaveBeenCalledWith('viewer@example.com', 'vid-1', null);
  });

  it('reports a failed write instead of claiming the vote stood', async () => {
    state.recordFails = true;
    const res = await post({ videoId: 'vid-1', vote: 'up' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Could not save your rating' });
  });

  it('refuses a vote that is neither up nor down', async () => {
    expect((await post({ videoId: 'vid-1', vote: 'sideways' })).statusCode).toBe(400);
    expect(state.recordRating).not.toHaveBeenCalled();
  });

  it('refuses a missing or wrong-typed id', async () => {
    expect((await post({ vote: 'up' })).statusCode).toBe(400);
    expect((await post({ videoId: ['vid-1'], vote: 'up' })).statusCode).toBe(400);
  });
});

describe('reading your own rating', () => {
  it('returns it and nothing else', async () => {
    state.stored = { 'vid-1': 'up' };
    const res = await call({ method: 'GET', query: { videoId: 'vid-1' } });
    expect(res.body).toEqual({ vote: 'up' });
  });
});
