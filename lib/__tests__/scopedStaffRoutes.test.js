// Group-scoped staff, end to end through the real route handlers.
//
// One staff member holds EVERY capability but is limited to the Youth group.
// Each test asks a route to do something outside Youth and checks that it is
// refused, and asks it to do the same inside Youth and checks that it works —
// so a refusal can never pass by the route simply being broken.
//
// The world:
//   groups   youth (videos V1, V3; collection CY)   deck (videos V2, V3)
//   videos   V1 youth only · V2 deck only · V3 both · V4 in no group ·
//            V5 in collection CY, so youth's through the collection
//   viewers  y1 [youth] · d1 [deck] · both [youth, deck] · free []
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mem } from './helpers/memoryRedis';

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V1 = guid(1);
const V2 = guid(2);
const V3 = guid(3);
const V4 = guid(4);
const V5 = guid(5);
const YOUTH = '11111111-1111-4111-8111-111111111111';
const DECK = '22222222-2222-4222-8222-222222222222';
const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const state = vi.hoisted(() => ({ email: null, deleted: [], created: 0, collections: [], transcribed: [] }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({
  getSession: async () => (state.email ? { user: { email: state.email } } : null),
}));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../monitor', () => ({ withMonitorApi: (h) => h }));
vi.mock('../ratelimit', () => ({ allow: async () => true, allowCostly: async () => true, callerId: () => 'test' }));
vi.mock('../push', () => ({ maybeAnnounceReady: async () => {} }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));
vi.mock('../captionsStore', () => ({
  clearTranscript: async () => {},
  saveTranscript: async () => {},
  markTranscribePending: async () => {},
}));
vi.mock('../commentsStore', () => ({ clearComments: async () => {} }));
vi.mock('../ratingsStore', () => ({ getRatingCounts: async () => ({}), clearVideoRatingCounts: async () => {} }));
vi.mock('../videoMetaStore', () => ({
  listVideoMeta: async () => ({}),
  setVideoMeta: async () => ({ meta: null, ignored: [] }),
  clearVideoMeta: async () => {},
}));
vi.mock('../watermark', () => ({
  listVideoWatermarkModes: async () => ({}),
  setVideoWatermarkMode: async () => {},
}));
vi.mock('../publicVideos', () => ({ listPublicVideos: async () => [], clearPublicVideo: async () => {} }));
vi.mock('../mail', () => ({ mailEnabled: () => false, sendShareBundle: async () => {} }));
vi.mock('../bunny', () => {
  const library = () => [
    { guid: guid(1), title: 'One', collectionId: '', status: 4, views: 5 },
    { guid: guid(2), title: 'Two', collectionId: '', status: 4, views: 7 },
    { guid: guid(3), title: 'Three', collectionId: '', status: 4, views: 1 },
    { guid: guid(4), title: 'Four', collectionId: '', status: 4, views: 9 },
    { guid: guid(5), title: 'Five', collectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 4, views: 2 },
  ];
  return {
    listVideosPage: async () => ({ items: library(), totalItems: library().length }),
    getVideoById: async (id) => library().find((v) => v.guid === id) || null,
    isVideoId: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value),
    getThumbnailUrl: () => null,
    getLibraryStatistics: async () => ({ viewsChart: { '2026-09-01': 99 } }),
    deleteVideo: async (id) => state.deleted.push(id),
    updateVideoTitle: async () => {},
    setVideoCollection: async (id, c) => state.collections.push([id, c]),
    createVideo: async () => (state.created++, 'new-video-id'),
    signTusUpload: () => ({ libraryId: 'l', signature: 's', expires: 1 }),
    listCollections: async () => [],
    createCollection: async () => ({ guid: 'c' }),
    deleteCollection: async () => {},
    transcribeVideo: async (id) => state.transcribed.push(id),
    fetchCaptionVtt: async () => null,
  };
});

const route = async (name) => (await import(`../../pages/api/admin/${name}.js`)).default;
const ADMIN_DIR = path.join(process.cwd(), 'pages/api/admin');

async function call(handler, { method = 'GET', query = {}, body = {} } = {}) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  await handler({ method, query, body, headers: { host: 'portal.example' }, cookies: {} }, res);
  return out;
}

const group = (id, name, videoIds, collectionIds = []) =>
  mem.hash('pvp:groups').set(id, JSON.stringify({ id, name, videoIds, collectionIds, createdAt: 1 }));
const member = (email, ...groupIds) => {
  for (const id of groupIds) {
    mem.set(`pvp:group_members:${id}`).add(email);
    mem.set(`pvp:user_groups:${email}`).add(id);
  }
};
const groupsOf = (email) => [...mem.set(`pvp:user_groups:${email}`)].sort();

async function seed() {
  const { ALL_CAPABILITIES } = await import('../capabilities');
  group(YOUTH, 'Youth', [V1, V3], [CY]);
  group(DECK, 'Deck', [V2, V3]);
  member('y1@x.com', YOUTH);
  member('d1@x.com', DECK);
  member('both@x.com', YOUTH, DECK);
  for (const e of ['y1@x.com', 'd1@x.com', 'both@x.com', 'free@x.com']) mem.set('pvp:approved_viewers').add(e);
  mem.hash('pvp:roles').set('all', JSON.stringify({ id: 'all', name: 'Everything', capabilities: [...ALL_CAPABILITIES] }));
  mem.hash('pvp:user_roles').set('s@x.com', JSON.stringify(['all']));
  mem.hash('pvp:user_roles').set('u@x.com', JSON.stringify(['all']));
  mem.hash('pvp:user_scope').set('s@x.com', JSON.stringify([YOUTH]));
}

beforeEach(async () => {
  mem.reset();
  state.deleted = [];
  state.created = 0;
  state.collections = [];
  state.transcribed = [];
  await seed();
  state.email = 's@x.com';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('every admin route is scope-aware (static)', () => {
  // A route either gates only on portal-wide capabilities — which a scoped
  // caller never holds — or handles the scope itself. A new route that does
  // neither fails here, before it can leak.
  const PORTAL_WIDE = ['settings:manage', 'roles:manage', 'audit:read'];
  const files = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.js'));
  it.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
    const caps = [...src.matchAll(/requireCapability\(req, res, '([a-z:]+)'\)/g)].map((m) => m[1]);
    expect(caps.length, `${file} has no requireCapability gate`).toBeGreaterThan(0);
    if (caps.every((c) => PORTAL_WIDE.includes(c))) return;
    expect(src, `${file} neither is portal-wide nor checks a staff scope`).toMatch(/staffScope(Rules)?'/);
  });
});

describe('portal-wide capabilities are gone under a scope', () => {
  it.each([
    ['settings', 'GET'],
    ['audit', 'GET'],
    ['roles', 'GET'],
    ['broadcast', 'POST'],
    ['public-videos', 'GET'],
    ['watermark', 'GET'],
    ['geo', 'GET'],
  ])('%s answers 403', async (name, method) => {
    expect((await call(await route(name), { method })).statusCode).toBe(403);
  });

  it('still answers the same routes for the unscoped holder of the same role', async () => {
    state.email = 'u@x.com';
    expect((await call(await route('roles'))).statusCode).toBe(200);
  });
});

describe('videos', () => {
  it('lists only the scope’s videos, through a collection too', async () => {
    const res = await call(await route('videos'));
    expect(res.body.map((v) => v.id).sort()).toEqual([V1, V3, V5]);
  });

  it('edits in-scope videos and answers 404 for the rest', async () => {
    const videos = await route('videos');
    const rename = (id) => call(videos, { method: 'PUT', body: { id, title: 'New' } });
    expect((await rename(V1)).statusCode).toBe(200);
    expect((await rename(V5)).statusCode).toBe(200);
    expect((await rename(V2)).statusCode).toBe(404);
    expect((await rename(V4)).statusCode).toBe(404);
  });

  it('deletes a video only its own groups can see', async () => {
    const videos = await route('videos');
    expect((await call(videos, { method: 'DELETE', body: { id: V3 } })).statusCode).toBe(403);
    expect((await call(videos, { method: 'DELETE', body: { id: V2 } })).statusCode).toBe(404);
    expect((await call(videos, { method: 'DELETE', body: { id: V1 } })).statusCode).toBe(200);
    expect(state.deleted).toEqual([V1]);
  });

  it('holds bulk delete to the same rule, video by video', async () => {
    const res = await call(await route('videos'), { method: 'DELETE', body: { ids: [V1, V2, V3] } });
    const ok = Object.fromEntries(res.body.results.map((r) => [r.id, r.ok]));
    expect(ok).toEqual({ [V1]: true, [V2]: false, [V3]: false });
    expect(state.deleted).toEqual([V1]);
  });

  it('refuses the library-wide acts: collections and the homepage order', async () => {
    expect((await call(await route('videos'), { method: 'PUT', body: { id: V1, collectionId: CY } })).statusCode).toBe(403);
    expect((await call(await route('order'), { method: 'POST', body: { order: [V1] } })).statusCode).toBe(403);
    expect((await call(await route('collections'), { method: 'POST', body: { name: 'X' } })).statusCode).toBe(403);
    expect(state.collections).toEqual([]);
  });

  it('shows only its own videos’ places in the homepage order', async () => {
    mem.strings.set('pvp:video_order', [V2, V1, V4, V3]);
    expect((await call(await route('order'))).body.order).toEqual([V1, V3]);
  });

  it('transcribes in-scope videos only', async () => {
    const transcribe = await route('transcribe');
    expect((await call(transcribe, { method: 'POST', body: { videoId: V2 } })).statusCode).toBe(404);
    expect(state.transcribed).toEqual([]);
    expect((await call(transcribe, { method: 'POST', body: { videoId: V1 } })).statusCode).toBe(200);
    expect(state.transcribed).toEqual([V1]);
  });

  it('sets per-group windows for its own groups only', async () => {
    const videos = await route('videos');
    const window = { publishAt: Date.now() + 86400000 };
    const set = (groups) => call(videos, { method: 'PUT', body: { id: V1, publishAt: null, expiresAt: null, groups } });
    expect((await set({ [YOUTH]: window })).statusCode).toBe(200);
    expect((await set({ [YOUTH]: window, [DECK]: window })).statusCode).toBe(403);
  });
});

describe('uploads', () => {
  it('grants a new upload to the caller’s groups, whether or not they chose', async () => {
    const res = await call(await route('upload'), { method: 'POST', body: { title: 'Talk' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.groups.granted).toEqual([YOUTH]);
  });

  it('refuses another group, or none, before the video exists', async () => {
    const upload = await route('upload');
    expect((await call(upload, { method: 'POST', body: { title: 'T', groupIds: [DECK] } })).statusCode).toBe(403);
    expect((await call(upload, { method: 'POST', body: { title: 'T', groupIds: [] } })).statusCode).toBe(400);
    expect(state.created).toBe(0);
  });
});

describe('viewers', () => {
  it('lists only the scope’s people', async () => {
    const res = await call(await route('viewers'));
    expect(res.body.map((v) => v.email).sort()).toEqual(['both@x.com', 'y1@x.com']);
  });

  it('approves new people into their group, membership first', async () => {
    const res = await call(await route('viewers'), { method: 'POST', body: { emails: 'new@x.com' } });
    expect(res.body.added).toBe(1);
    expect(groupsOf('new@x.com')).toEqual([YOUTH]);
    expect(mem.set('pvp:approved_viewers').has('new@x.com')).toBe(true);
  });

  it('refuses to approve into a group that is not theirs, writing nothing', async () => {
    const res = await call(await route('viewers'), { method: 'POST', body: { emails: 'new@x.com', groupId: DECK } });
    expect(res.statusCode).toBe(400);
    expect(mem.set('pvp:approved_viewers').has('new@x.com')).toBe(false);
    expect(groupsOf('new@x.com')).toEqual([]);
  });

  it('leaves someone who is already a viewer as they are', async () => {
    await call(await route('viewers'), { method: 'POST', body: { emails: 'free@x.com' } });
    expect(groupsOf('free@x.com')).toEqual([]);
  });

  it('removes only someone wholly inside the scope, and never a role holder', async () => {
    const viewers = await route('viewers');
    const del = (email) => call(viewers, { method: 'DELETE', body: { email } });
    expect((await del('both@x.com')).statusCode).toBe(403);
    expect((await del('free@x.com')).statusCode).toBe(404);
    member('u@x.com', YOUTH);
    mem.set('pvp:approved_viewers').add('u@x.com');
    expect((await del('u@x.com')).statusCode).toBe(403);
    expect((await del('y1@x.com')).statusCode).toBe(200);
    expect(mem.set('pvp:approved_viewers').has('y1@x.com')).toBe(false);
  });

  it('labels only their own people', async () => {
    const viewers = await route('viewers');
    const tag = (email) => call(viewers, { method: 'PATCH', body: { email, tags: ['x'] } });
    expect((await tag('d1@x.com')).statusCode).toBe(404);
    expect((await tag('y1@x.com')).statusCode).toBe(200);
  });

  it('approves an access request into their group', async () => {
    mem.hash('pvp:access_requests').set('asker@x.com', JSON.stringify({ email: 'asker@x.com', status: 'pending', requestedAt: 1 }));
    const res = await call(await route('access-requests'), { method: 'POST', body: { email: 'asker@x.com', status: 'approved' } });
    expect(res.statusCode).toBe(200);
    expect(groupsOf('asker@x.com')).toEqual([YOUTH]);
    expect(mem.set('pvp:approved_viewers').has('asker@x.com')).toBe(true);
  });

  it('refuses to approve a request into someone else’s group, deciding nothing', async () => {
    mem.hash('pvp:access_requests').set('asker@x.com', JSON.stringify({ email: 'asker@x.com', status: 'pending', requestedAt: 1 }));
    const res = await call(await route('access-requests'), {
      method: 'POST',
      body: { email: 'asker@x.com', status: 'approved', groupId: DECK },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(mem.hash('pvp:access_requests').get('asker@x.com')).status).toBe('pending');
    expect(mem.set('pvp:approved_viewers').has('asker@x.com')).toBe(false);
  });
});

describe('groups', () => {
  it('shows only their groups', async () => {
    const res = await call(await route('groups'));
    expect(res.body.map((g) => g.id)).toEqual([YOUTH]);
  });

  it('refuses to create, re-grant or delete a group', async () => {
    const groups = await route('groups');
    expect((await call(groups, { method: 'POST', body: { name: 'New' } })).statusCode).toBe(403);
    expect((await call(groups, { method: 'PATCH', body: { groupId: YOUTH, videoIds: [V2] } })).statusCode).toBe(403);
    expect((await call(groups, { method: 'DELETE', body: { groupId: YOUTH } })).statusCode).toBe(403);
    expect(JSON.parse(mem.hash('pvp:groups').get(YOUTH)).videoIds).toEqual([V1, V3]);
  });

  it('adds only people already in scope', async () => {
    const res = await call(await route('groups'), {
      method: 'POST',
      body: { groupId: YOUTH, emails: 'd1@x.com free@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(groupsOf('d1@x.com')).toEqual([DECK]);
    expect(groupsOf('free@x.com')).toEqual([]);
  });

  it('never takes anyone out of their last group', async () => {
    const groups = await route('groups');
    const remove = (email) => call(groups, { method: 'DELETE', body: { groupId: YOUTH, email } });
    expect((await remove('y1@x.com')).statusCode).toBe(403);
    expect(groupsOf('y1@x.com')).toEqual([YOUTH]);
    expect((await remove('both@x.com')).statusCode).toBe(200);
    expect(groupsOf('both@x.com')).toEqual([DECK]);
  });

  it('answers 404 for someone else’s group', async () => {
    const res = await call(await route('groups'), { method: 'POST', body: { groupId: DECK, emails: 'y1@x.com' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('shares and analytics', () => {
  const link = (id, videoId) => {
    mem.strings.set(`pvp:share:${id}`, {
      videoId,
      title: 't',
      email: 'g@x.com',
      createdAt: 1,
      expiresAt: Date.now() + 86400000,
    });
    mem.set('pvp:active_shares').add(id);
  };

  it('shares in-scope videos only', async () => {
    const share = await route('share');
    const make = (ids) => call(share, { method: 'POST', body: { videos: ids.map((id) => ({ id, title: 't' })), emails: ['g@x.com'] } });
    expect((await make([V1, V2])).statusCode).toBe(404);
    expect((await make([V1])).statusCode).toBe(200);
  });

  it('lists and revokes only links to in-scope videos', async () => {
    link('s1', V1);
    link('s2', V2);
    const shares = await route('shares');
    expect((await call(shares)).body.map((s) => s.videoId)).toEqual([V1]);
    expect((await call(shares, { method: 'DELETE', body: { shareIds: ['s1', 's2'] } })).statusCode).toBe(404);
    expect(mem.strings.get('pvp:share:s2').revoked).toBeUndefined();
  });

  it('keeps private lists and per-video analytics to in-scope videos', async () => {
    link('s1', V1);
    link('s2', V2);
    expect(Object.keys((await call(await route('video-analytics'))).body)).toEqual([V1]);
    const list = await route('private-list');
    expect((await call(list, { method: 'POST', body: { videoId: V2, emails: ['g@x.com'] } })).statusCode).toBe(404);
  });

  it('reads another viewer’s watch history only for the scope’s people', async () => {
    const progress = (await import('../../pages/api/progress.js')).default;
    for (const email of ['y1@x.com', 'd1@x.com']) {
      mem.hash(`pvp:progress:${email}`).set(V3, { seconds: 10, duration: 60, title: 't', at: 1 });
    }
    const history = async (email) => (await call(progress, { query: { email } })).body;
    expect(await history('d1@x.com')).toEqual([]);
    expect((await history('y1@x.com')).map((e) => e.id)).toEqual([V3]);
  });

  it('counts only in-scope videos, and leaves out the library-wide figures', async () => {
    const res = await call(await route('analytics'));
    expect(res.body.videoCount).toBe(3);
    expect(res.body.totalViews).toBe(8);
    expect(res.body.libraryWide).toBe(false);
    expect(res.body.chart).toEqual([]);
  });
});

describe('the scope itself', () => {
  let roles;
  const assign = (body) => call(roles, { method: 'PATCH', body });
  const scopeOf = (email) => mem.hash('pvp:user_scope').get(email);
  beforeEach(async () => {
    roles = await route('roles');
    state.email = 'admin@example.com';
  });

  it('is set and lifted through the Roles route', async () => {
    const set = await assign({ email: 'u@x.com', roleIds: ['all'], scope: [DECK] });
    expect(set.statusCode).toBe(200);
    expect(set.body.scope).toEqual([DECK]);
    expect(JSON.parse(scopeOf('u@x.com'))).toEqual([DECK]);
    const lifted = await assign({ email: 'u@x.com', roleIds: ['all'], scope: null });
    expect(lifted.body.scope).toBe(null);
    expect(scopeOf('u@x.com')).toBeUndefined();
  });

  it('is listed for the Roles tab with the groups to choose from', async () => {
    const res = await call(roles);
    expect(res.body.scopes).toEqual({ 's@x.com': [YOUTH] });
    expect(res.body.scopeGroups.map((g) => g.name)).toEqual(['Deck', 'Youth']);
  });

  it('names real groups only', async () => {
    expect((await assign({ email: 'u@x.com', roleIds: ['all'], scope: ['nope'] })).statusCode).toBe(400);
    expect(scopeOf('u@x.com')).toBeUndefined();
  });

  it('goes with the last role', async () => {
    await assign({ email: 's@x.com', roleIds: [] });
    expect(scopeOf('s@x.com')).toBeUndefined();
  });

  it('is out of reach of the scoped person themselves', async () => {
    state.email = 's@x.com';
    expect((await assign({ email: 's@x.com', roleIds: ['all'], scope: null })).statusCode).toBe(403);
  });
});
