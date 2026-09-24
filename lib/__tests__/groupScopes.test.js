// A group scope must not outlive what it grants.
//
// Groups here grant by collection as well as by video, and deleting a
// collection left every grant naming it in place. That is the same
// no-orphans rule this repo already applies to per-viewer keys (weak point
// #3), unapplied to a scope: clutter an admin has to reason around when
// deciding who sees what, and — if an id is ever reused — a grant
// transferring to a collection nobody granted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let stored = {};

vi.mock('../redis', () => ({
  k: (name) => `pvp:${name}`,
  redis: {
    hgetall: async () => stored,
    hget: async (key, field) => stored[field] || null,
    // Writes back, so a test can assert what a prune actually stored. A
    // no-op here would make that assertion unfalsifiable.
    hset: async (key, payload) => {
      Object.assign(stored, payload);
      return 1;
    },
    hdel: async (key, field) => {
      delete stored[field];
      return 1;
    },
    smembers: async () => [],
  },
}));

const { pruneCollectionFromGroups, listGroups } = await import('../groups');

const record = (id, collectionIds, videoIds = []) =>
  JSON.stringify({ id, name: id, collectionIds, videoIds, createdAt: null, createdBy: null });

beforeEach(() => {
  stored = {
    g1: record('g1', ['c1', 'c2'], ['v1']),
    g2: record('g2', ['c2']),
    g3: record('g3', []),
  };
});

describe('pruneCollectionFromGroups', () => {
  it('drops the collection from every group that granted it', async () => {
    expect(await pruneCollectionFromGroups('c2')).toBe(2);
    const groups = Object.fromEntries((await listGroups()).map((g) => [g.id, g]));
    expect(groups.g1.collectionIds).toEqual(['c1']);
    expect(groups.g2.collectionIds).toEqual([]);
    expect(groups.g3.collectionIds).toEqual([]);
  });

  it('leaves video grants untouched', async () => {
    // Only the collection half is stale; removing a video grant here would
    // silently narrow what the group can see.
    await pruneCollectionFromGroups('c2');
    const groups = await listGroups();
    expect(groups.find((g) => g.id === 'g1').videoIds).toEqual(['v1']);
  });

  it('does nothing for an unknown or empty id', async () => {
    expect(await pruneCollectionFromGroups('nope')).toBe(0);
    expect(await pruneCollectionFromGroups('')).toBe(0);
    expect(await pruneCollectionFromGroups(null)).toBe(0);
    const groups = await listGroups();
    expect(groups.find((g) => g.id === 'g1').collectionIds).toEqual(['c1', 'c2']);
  });

  it('never throws into the delete path', async () => {
    // Failing to tidy a scope must not turn a successful collection delete
    // into an error the admin has to interpret.
    stored = { g1: 'not json at all' };
    await expect(pruneCollectionFromGroups('c1')).resolves.toBe(0);
  });
});
