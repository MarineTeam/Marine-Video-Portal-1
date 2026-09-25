// pages/api/admin/groups.js — the capability split custom roles made
// necessary. groups:manage runs the group RECORD; seeing or changing who is IN
// a group is about people, and additionally needs viewers:manage.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ caps: [], added: [], removed: [], created: [] }));

vi.mock('../roles', () => ({
  requireCapability: async (req, res, cap) => {
    if (!state.caps.includes(cap)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return { email: 'staff@x.com', owner: false, session: {}, capabilities: state.caps };
  },
}));
vi.mock('../groups', () => ({
  listGroups: async () => [{ id: 'g1', name: 'Crew', collectionIds: [], videoIds: [], members: ['a@x.com', 'b@x.com'] }],
  createGroup: async (name) => (state.created.push(name), { id: 'g2', name }),
  updateGroup: async (id, patch) => ({ id, name: patch.name, collectionIds: [], videoIds: [] }),
  deleteGroup: async () => ({ ok: true }),
  addGroupMembers: async (id, emails) => (state.added.push(...emails), { added: emails, unknown: [], invalid: [] }),
  removeGroupMember: async (id, email) => state.removed.push(email),
}));
vi.mock('../redis', () => ({ k: (x) => `pvp:${x}`, redis: { smembers: async () => ['a@x.com'] } }));
vi.mock('../schedule', () => ({ pruneGroupFromSchedules: async () => {} }));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../monitor', () => ({ withMonitorApi: (h) => h }));

const route = (await import('../../pages/api/admin/groups')).default;

async function call(method, body = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => res;
  await route({ method, body, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  state.caps = ['groups:manage'];
  state.added = [];
  state.removed = [];
  state.created = [];
});

describe('groups:manage without viewers:manage', () => {
  it('sees each group with a member count, never the members', async () => {
    const res = await call('GET');
    expect(res.body).toEqual([{ id: 'g1', name: 'Crew', collectionIds: [], videoIds: [], memberCount: 2 }]);
    expect(JSON.stringify(res.body)).not.toContain('a@x.com');
  });

  it('cannot add or remove members', async () => {
    expect((await call('POST', { groupId: 'g1', emails: ['a@x.com'] })).statusCode).toBe(403);
    expect((await call('DELETE', { groupId: 'g1', email: 'a@x.com' })).statusCode).toBe(403);
    expect(state.added).toEqual([]);
    expect(state.removed).toEqual([]);
  });

  it('still runs the group record: create, rename, delete', async () => {
    expect((await call('POST', { name: 'New' })).statusCode).toBe(200);
    expect((await call('PATCH', { groupId: 'g1', name: 'Renamed' })).statusCode).toBe(200);
    expect((await call('DELETE', { groupId: 'g1' })).statusCode).toBe(200);
    expect(state.created).toEqual(['New']);
  });
});

describe('groups:manage with viewers:manage', () => {
  beforeEach(() => {
    state.caps = ['groups:manage', 'viewers:manage'];
  });

  it('sees the members', async () => {
    expect((await call('GET')).body[0].members).toEqual(['a@x.com', 'b@x.com']);
  });

  it('adds and removes members', async () => {
    expect((await call('POST', { groupId: 'g1', emails: ['a@x.com'] })).statusCode).toBe(200);
    expect((await call('DELETE', { groupId: 'g1', email: 'a@x.com' })).statusCode).toBe(200);
    expect(state.added).toEqual(['a@x.com']);
    expect(state.removed).toEqual(['a@x.com']);
  });
});

it('is closed to viewers:manage alone', async () => {
  state.caps = ['viewers:manage'];
  expect((await call('GET')).statusCode).toBe(403);
});
