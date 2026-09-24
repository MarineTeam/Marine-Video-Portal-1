import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/transcript/[id].js — the GATE and the language choice, not the
// parsing (captions.test.js) or the storage (a manual E2E concern).
//
// A transcript is the entire content of a private video in text form, so this
// route must be exactly as strict as pages/watch/video/[id].js. Each gate test
// corresponds to one check that page performs and fails if the route stops
// performing it. Check 4 (verified email) exists only in this repo and is the
// one most likely to be lost in a port, so it gets its own test.

const state = vi.hoisted(() => ({
  session: null,
  approved: true,
  staff: false,
  geo: true,
  verified: true,
  canSee: true,
  visible: true,
  videos: [{ guid: 'vid-1' }],
  videosThrow: false,
  languages: { default: 'en', all: ['en'] },
  getTranscript: null,
}));

vi.mock('../auth0', () => ({ getSession: async () => state.session }));
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
vi.mock('../bunny', () => ({
}));
vi.mock('../videoLibrary', () => ({
  findVideo: async (id) => {
    if (state.videosThrow) throw new Error('bunny down');
    return state.videos.find((v) => v.guid === id) || null;
  },
}));
vi.mock('../captionsStore', () => ({
  getTranscript: (...args) => state.getTranscript(...args),
  getTranscriptLanguages: async () => state.languages,
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/transcript/[id]')).default;

function mockRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; return res; };
  return res;
}

async function call(query = { id: 'vid-1' }, method = 'GET') {
  const res = mockRes();
  await route({ method, query, headers: {} }, res);
  return res;
}

beforeEach(() => {
  Object.assign(state, {
    session: { user: { email: 'Viewer@Example.com' } },
    approved: true,
    staff: false,
    geo: true,
    verified: true,
    canSee: true,
    visible: true,
    videos: [{ guid: 'vid-1' }],
    videosThrow: false,
    languages: { default: 'en', all: ['en'] },
    getTranscript: vi.fn(async (id, lang) => [{ start: 1, end: 2, text: `${lang} words` }]),
  });
});

describe('who can read a transcript', () => {
  it('serves cues to an approved, verified viewer', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.cues).toHaveLength(1);
  });

  it('refuses an anonymous caller before touching storage', async () => {
    state.session = null;
    const res = await call();
    expect(res.statusCode).toBe(401);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user who is neither approved nor staff', async () => {
    state.approved = false;
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it('refuses a blocked region', async () => {
    state.geo = false;
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it('refuses an UNVERIFIED email — the check sibling repos do not have', async () => {
    state.verified = false;
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it('404s (not 403s) a video outside the viewer\'s groups', async () => {
    state.canSee = false;
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it('404s an unknown id', async () => {
    const res = await call({ id: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a viewer outside the publish window', async () => {
    state.visible = false;
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(state.getTranscript).not.toHaveBeenCalled();
  });

  it("checks the publish window with the viewer's groups", async () => {
    state.windowGroups = undefined;
    await call();
    expect(state.windowGroups).toEqual(['grp-1']);
  });

  it('lets staff read outside the publish window', async () => {
    state.visible = false;
    state.staff = true;
    const res = await call();
    expect(res.statusCode).toBe(200);
  });

  it('400s a missing or wrong-typed id', async () => {
    expect((await call({})).statusCode).toBe(400);
    expect((await call({ id: ['vid-1'] })).statusCode).toBe(400);
  });

  it('405s a non-GET and names the allowed verb', async () => {
    const res = await call({ id: 'vid-1' }, 'POST');
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
  });

  it('502s when the video list cannot load, without leaking the error', async () => {
    state.videosThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('bunny down');
  });
});

describe('which language is served', () => {
  beforeEach(() => {
    state.languages = { default: 'en', all: ['en', 'es'] };
  });

  it('serves the default when none is asked for', async () => {
    const res = await call();
    expect(res.body.language).toBe('en');
    expect(res.body.languages).toEqual(['en', 'es']);
    expect(res.body.missing).toBe(false);
    expect(state.getTranscript).toHaveBeenCalledWith('vid-1', 'en');
  });

  it('serves the language that was asked for', async () => {
    const res = await call({ id: 'vid-1', lang: 'es' });
    expect(res.body.language).toBe('es');
    expect(res.body.cues[0].text).toBe('es words');
  });

  it('REPORTS a language it does not have rather than pretending', async () => {
    const res = await call({ id: 'vid-1', lang: 'fr' });
    expect(res.body.language).toBe('en');
    expect(res.body.missing).toBe(true);
  });

  it('ignores a wrong-typed lang instead of stringifying it', async () => {
    const res = await call({ id: 'vid-1', lang: ['es'] });
    expect(res.body.language).toBe('en');
    expect(res.body.missing).toBe(false);
  });

  it('answers an untranscribed video with an empty list, not an error', async () => {
    state.languages = { default: null, all: [] };
    state.getTranscript = vi.fn(async () => []);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ cues: [], language: null, languages: [], missing: false });
  });
});
