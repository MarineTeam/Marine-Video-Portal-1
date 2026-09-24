// The transcript collection lock (lib/captionsStore.js) against a REAL
// redis-server: SET NX EX to take it, and the compare-and-delete script to
// release it. A mock could only echo back what the test told it; the point is
// what Redis does — above all, that releasing with a stale token leaves a
// newer holder's lock alone.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalScript, shouldSkip, startRedis } from './helpers/localRedis';

let server;
let r;

// The subset of the Upstash client the lock uses, in Upstash's shapes.
const adapter = {
  set: async (key, value, { nx, ex } = {}) => {
    const args = ['SET', key, value];
    if (nx) args.push('NX');
    if (ex) args.push('EX', ex);
    return r.call(...args);
  },
  eval: (script, keys, args) => evalScript(r, script, keys, args),
};

vi.mock('../redis', () => ({
  redis: adapter,
  k: (key) => `pvp:${key}`,
}));

const { acquireCollectLock, releaseCollectLock } = await import('../captionsStore');
const KEY = 'pvp:transcribe_collecting';

describe.skipIf(shouldSkip)('collection lock on a real redis-server', () => {
  beforeAll(async () => {
    server = await startRedis();
    r = server.client;
  });
  afterAll(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    await r.call('FLUSHALL');
  });

  it('lets one run in and keeps the second out', async () => {
    const first = await acquireCollectLock();
    expect(first).toMatch(/^lock-/);
    expect(await acquireCollectLock()).toBeNull();
  });

  it('expires on its own, so a crashed run cannot block collection for good', async () => {
    await acquireCollectLock();
    const ttl = await r.call('TTL', KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('is free again once released', async () => {
    const token = await acquireCollectLock();
    await releaseCollectLock(token);
    expect(await acquireCollectLock()).not.toBeNull();
  });

  it("does NOT release a lock a newer run holds — only the holder's token does", async () => {
    const stale = await acquireCollectLock();
    // The first run outlived its lock; a second run took a fresh one.
    await r.call('DEL', KEY);
    const current = await acquireCollectLock();
    await releaseCollectLock(stale);
    expect(await r.call('GET', KEY)).toBe(current);
  });
});
