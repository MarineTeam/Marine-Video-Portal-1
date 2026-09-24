import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/comments.js — who may read, write and delete comments.
//
// The same gate as the watch page (approved or staff, region, verified email,
// the video exists, group grants, the publish window for reading and writing
// with staff exempt). The author is the SESSION; other viewers never see an
// email; removing someone else's comment needs comments:manage (admins and
// managers) and is audited. Roles come from the REAL capability table.

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const state = vi.hoisted(() => ({
  session: null,
  approved: true,
  role: 'viewer',
  geo: true,
  verified: true,
  videoExists: true,
  canSee: true,
  visible: true,
  allowed: true,
  store: {},
  full: false,
  audit: [],
}));

vi.mock('@auth0/nextjs-auth0', () => ({ getSession: async () => state.session }));
vi.mock('../redis', () => ({ k: (key) => `pvp:${key}`, redis: { sismember: async () => (state.approved ? 1 : 0) } }));
vi.mock('../roles', async () => ({
  ...(await vi.importActual('../roles')),
  getRole: async () => state.role,
}));
vi.mock('../verification', () => ({ isVerified: async () => state.verified }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => state.geo }));
vi.mock('../groups', () => ({ resolveAccess: async () => ({ groupIds: [] }), canSeeVideo: () => state.canSee }));
vi.mock('../schedule', () => ({ getSchedule: async () => null, isVisibleFor: () => state.visible }));
vi.mock('../ratelimit', () => ({ allowWriting: async () => state.allowed, callerId: () => 'test' }));
vi.mock('../bunny', () => ({
  getVideoById: async (id) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid videoId');
    return state.videoExists ? { guid: id, collectionId: '' } : null;
  },
}));
vi.mock('../audit', () => ({ logAudit: async (...a) => state.audit.push(a) }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));
vi.mock('../commentsStore', async () => {
  const { parseComment, sortComments } = await vi.importActual('../comments');
  let n = 0;
  return {
    listComments: async (g) => sortComments(Object.values(state.store[g] || {}).map(parseComment)),
    getComment: async (g, id) => (state.store[g]?.[id] ? parseComment(state.store[g][id]) : null),
    addComment: async (g, { email, name, text }) => {
      if (state.full) return { ok: false, error: 'full' };
      n += 1;
      const comment = { id: `cnew${String(n).padStart(4, '0')}`, email, name, text, at: 1000 + n };
      state.store[g] = { ...(state.store[g] || {}), [comment.id]: comment };
      return { ok: true, comment: parseComment(comment) };
    },
    deleteComment: async (g, id) => {
      delete state.store[g]?.[id];
    },
  };
});

const route = (await import('../../pages/api/comments')).default;

async function call({ method = 'GET', query = {}, body = {} } = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => res;
  await route({ method, query, body, headers: {} }, res);
  return res;
}
const get = () => call({ query: { videoId: GUID } });
const post = (body) => call({ method: 'POST', body: { videoId: GUID, ...body } });
const del = (id) => call({ method: 'DELETE', query: { videoId: GUID, id } });
const as = (email, role = 'viewer', name = 'Bob Jones') => {
  state.session = { user: { email, name } };
  state.role = role;
};
const janes = { id: 'cjane0001', email: 'jane@example.com', name: 'Jane Smith', text: 'Amen', at: 1 };

beforeEach(() => {
  as('bob@example.com');
  Object.assign(state, {
    approved: true, geo: true, verified: true, videoExists: true, canSee: true,
    visible: true, allowed: true, full: false, audit: [],
    store: { [GUID]: { [janes.id]: { ...janes } } },
  });
});

describe('the gate', () => {
  it('refuses a signed-out caller, an unapproved one, a blocked region and an unverified email', async () => {
    state.session = null;
    expect((await get()).statusCode).toBe(401);
    as('bob@example.com');
    state.approved = false;
    expect((await get()).statusCode).toBe(403);
    state.approved = true;
    state.geo = false;
    expect((await get()).statusCode).toBe(403);
    state.geo = true;
    state.verified = false;
    expect((await get()).statusCode).toBe(403);
  });

  it('refuses a missing id and other methods', async () => {
    expect((await call({ query: {} })).statusCode).toBe(400);
    expect((await call({ method: 'PUT', query: { videoId: GUID } })).statusCode).toBe(405);
  });

  it.each(['GET', 'POST', 'DELETE'])('404s a %s on a missing video, a bad id, or one outside the viewer’s groups', async (method) => {
    for (const arrange of [() => (state.videoExists = false), () => (state.canSee = false), () => 'bad-id']) {
      state.videoExists = true;
      state.canSee = true;
      const bad = arrange() === 'bad-id';
      const videoId = bad ? 'not-a-guid' : GUID;
      const res = await call({ method, query: { videoId, id: janes.id }, body: { videoId, text: 'hi' } });
      expect(res.statusCode).toBe(404);
    }
    expect(Object.keys(state.store[GUID])).toEqual([janes.id]);
  });

  it('404s reading or writing outside the publish window, but not for staff', async () => {
    state.visible = false;
    expect((await get()).statusCode).toBe(404);
    expect((await post({ text: 'early' })).statusCode).toBe(404);
    as('mgr@example.com', 'manager');
    expect((await get()).statusCode).toBe(200);
  });
});

describe('reading', () => {
  it('shows names and never emails to a viewer', async () => {
    const res = await get();
    expect(res.body.comments).toEqual([{ id: janes.id, name: 'Jane Smith', text: 'Amen', at: 1, mine: false, canDelete: false }]);
    expect(JSON.stringify(res.body)).not.toContain('jane@example.com');
  });

  it('shows the email to staff who manage viewers', async () => {
    as('mgr@example.com', 'manager');
    expect((await get()).body.comments[0].email).toBe('jane@example.com');
  });
});

describe('writing', () => {
  it('posts as the session’s person, under their profile name', async () => {
    const res = await post({ text: ' Thank you ', email: 'jane@example.com' });
    expect(res.body.comment).toMatchObject({ name: 'Bob Jones', text: 'Thank you', mine: true });
    expect(Object.values(state.store[GUID]).find((c) => c.text === 'Thank you').email).toBe('bob@example.com');
  });

  it('never shows an email-shaped profile name', async () => {
    as('bob@example.com', 'viewer', 'bob@example.com');
    expect((await post({ text: 'hello' })).body.comment.name).toBe('bob');
  });

  it('refuses an empty or oversized comment, a full video, and a flood', async () => {
    expect((await post({ text: ' ' })).statusCode).toBe(400);
    expect((await post({ text: 'x'.repeat(1001) })).statusCode).toBe(400);
    state.full = true;
    expect((await post({ text: 'more' })).statusCode).toBe(409);
    state.allowed = false;
    expect((await post({ text: 'spam' })).statusCode).toBe(429);
  });
});

describe('deleting', () => {
  it('lets an author delete their own, even outside the window, unaudited', async () => {
    as('jane@example.com');
    state.visible = false;
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(state.store[GUID][janes.id]).toBeUndefined();
    expect(state.audit).toEqual([]);
  });

  it('refuses a viewer deleting someone else’s comment', async () => {
    expect((await del(janes.id)).statusCode).toBe(403);
    expect(state.store[GUID][janes.id]).toBeDefined();
  });

  it.each(['manager', 'admin'])('lets a %s remove anyone’s comment, and audits it', async (role) => {
    as(`${role}@example.com`, role);
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(state.audit).toEqual([[`${role}@example.com`, 'comment.delete', `${GUID}: a comment by Jane Smith`]]);
  });

  it('404s a comment that does not exist', async () => {
    as('jane@example.com');
    expect((await del('cmissing01')).statusCode).toBe(404);
  });
});
