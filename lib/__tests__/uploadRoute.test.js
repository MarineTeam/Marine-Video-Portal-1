import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/admin/upload.js — choosing groups at upload time.
//
// The properties that matter: granting a group is a groups:manage act even
// when it arrives on the upload form; every refusal happens BEFORE the
// bunny.net video is created (so a refused request leaves no orphan); and a
// grant failing AFTER creation never fails the upload the browser is about to
// send, but is reported group by group.

const state = vi.hoisted(() => ({
  auth: { email: 'manager@example.com', role: 'manager', session: {} },
  canGrant: true,
  groupIds: ['g1', 'g2'],
  groupsThrow: false,
  grant: null,
  created: [],
  audit: [],
}));

vi.mock('../roles', () => ({
  requireCapability: async () => state.auth,
  roleHasCapability: (_role, cap) => (cap === 'groups:manage' ? state.canGrant : true),
}));
vi.mock('../groups', () => ({
  listGroupIds: async () => {
    if (state.groupsThrow) throw new Error('redis down');
    return state.groupIds;
  },
  grantVideoToGroups: (...args) => state.grant(...args),
}));
vi.mock('../audit', () => ({ logAudit: async (...args) => state.audit.push(args) }));
vi.mock('../bunny', () => ({
  createVideo: async (title) => {
    state.created.push(title);
    return 'vid-new';
  },
  signTusUpload: () => ({ libraryId: 1, signature: 'sig', expires: 9 }),
}));
vi.mock('../ratelimit', () => ({ allow: async () => true, callerId: () => 'test' }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/admin/upload')).default;

async function upload(body) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  await route({ method: 'POST', body, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  state.canGrant = true;
  state.groupIds = ['g1', 'g2'];
  state.groupsThrow = false;
  state.created = [];
  state.audit = [];
  state.grant = vi.fn(async (_id, ids) => ({ granted: ids, failed: [] }));
});

describe('upload with no groups', () => {
  it('is exactly the request it always was — no group read, no grant', async () => {
    state.groupsThrow = true; // would 502 if the route touched groups at all
    const res = await upload({ title: 'Sunday' });
    expect(res.statusCode).toBe(200);
    expect(state.created).toEqual(['Sunday']);
    expect(state.grant).not.toHaveBeenCalled();
    expect(res.body.groups).toEqual({ granted: [], failed: [] });
  });
});

describe('upload with groups', () => {
  it('grants the new video to the chosen groups and audits it', async () => {
    const res = await upload({ title: 'Sunday', groupIds: ['g1', 'g2'] });
    expect(res.statusCode).toBe(200);
    expect(state.grant).toHaveBeenCalledWith('vid-new', ['g1', 'g2']);
    expect(res.body.groups).toEqual({ granted: ['g1', 'g2'], failed: [] });
    expect(state.audit[0][0]).toBe('manager@example.com');
    expect(state.audit[0][2]).toContain('vid-new');
  });

  it('refuses a caller without groups:manage BEFORE creating the video', async () => {
    state.canGrant = false;
    const res = await upload({ title: 'Sunday', groupIds: ['g1'] });
    expect(res.statusCode).toBe(403);
    expect(state.created).toEqual([]);
  });

  it('refuses a group that no longer exists BEFORE creating the video', async () => {
    const res = await upload({ title: 'Sunday', groupIds: ['g1', 'deleted'] });
    expect(res.statusCode).toBe(400);
    expect(state.created).toEqual([]);
  });

  it('502s without creating the video when groups cannot be read', async () => {
    state.groupsThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload({ title: 'Sunday', groupIds: ['g1'] });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(state.created).toEqual([]);
  });

  it('still starts the upload when a grant fails afterwards, and says which', async () => {
    state.grant = vi.fn(async () => ({ granted: ['g1'], failed: ['g2'] }));
    const res = await upload({ title: 'Sunday', groupIds: ['g1', 'g2'] });
    expect(res.statusCode).toBe(200);
    expect(res.body.signature).toBe('sig');
    expect(res.body.groups).toEqual({ granted: ['g1'], failed: ['g2'] });
  });

  it('audits nothing when nothing was granted', async () => {
    state.grant = vi.fn(async () => ({ granted: [], failed: ['g1'] }));
    await upload({ title: 'Sunday', groupIds: ['g1'] });
    expect(state.audit).toEqual([]);
  });
});
