import { describe, it, expect, beforeEach, vi } from 'vitest';

// grantVideoToGroups and pruneVideosFromGroups against an in-memory stand-in
// for the groups hash. Both are read-modify-write over group records, so what
// matters is that they touch exactly the groups they should, keep every other
// grant intact, and report failures per group.

const state = vi.hoisted(() => ({ hash: {}, failOn: null }));

vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    hgetall: async () => ({ ...state.hash }),
    hget: async (_key, field) => {
      if (field === state.failOn) throw new Error('redis down');
      return state.hash[field] ?? null;
    },
    hset: async (_key, obj) => Object.assign(state.hash, obj),
    smembers: async () => [],
  },
}));

const { grantVideoToGroups, pruneVideosFromGroups, listGroupIds } = await import('../groups');

const group = (id, over = {}) =>
  JSON.stringify({ id, name: id, collectionIds: [], videoIds: [], ...over });
const videosOf = (id) => JSON.parse(state.hash[id]).videoIds;

beforeEach(() => {
  state.failOn = null;
  state.hash = {
    g1: group('g1', { videoIds: ['old'] }),
    g2: group('g2', { collectionIds: ['c1'] }),
    g3: group('g3'),
  };
});

describe('grantVideoToGroups', () => {
  it('adds the video to exactly the chosen groups, keeping their other grants', async () => {
    expect(await grantVideoToGroups('new', ['g1', 'g2'])).toEqual({ granted: ['g1', 'g2'], failed: [] });
    expect(videosOf('g1')).toEqual(['old', 'new']);
    expect(videosOf('g2')).toEqual(['new']);
    expect(JSON.parse(state.hash.g2).collectionIds).toEqual(['c1']);
    expect(videosOf('g3')).toEqual([]);
  });

  it('does not add the same video twice', async () => {
    await grantVideoToGroups('old', ['g1']);
    expect(videosOf('g1')).toEqual(['old']);
  });

  it('reports a group it could not grant, and still grants the rest', async () => {
    state.failOn = 'g2';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await grantVideoToGroups('new', ['g1', 'g2', 'g3']);
    spy.mockRestore();
    expect(result).toEqual({ granted: ['g1', 'g3'], failed: ['g2'] });
    expect(videosOf('g3')).toEqual(['new']);
  });

  it('reports a group deleted in the meantime as failed, not granted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await grantVideoToGroups('new', ['gone']);
    spy.mockRestore();
    expect(result).toEqual({ granted: [], failed: ['gone'] });
  });
});

describe('pruneVideosFromGroups', () => {
  it('removes deleted videos from every group that granted them, and nothing else', async () => {
    state.hash.g3 = group('g3', { videoIds: ['old', 'keep'] });
    expect(await pruneVideosFromGroups(['old'])).toBe(2);
    expect(videosOf('g1')).toEqual([]);
    expect(videosOf('g3')).toEqual(['keep']);
    expect(JSON.parse(state.hash.g2).collectionIds).toEqual(['c1']);
  });

  it('is a no-op for nothing', async () => {
    expect(await pruneVideosFromGroups([])).toBe(0);
  });
});

describe('listGroupIds', () => {
  it('lists ids without reading members', async () => {
    expect((await listGroupIds()).sort()).toEqual(['g1', 'g2', 'g3']);
  });
});
