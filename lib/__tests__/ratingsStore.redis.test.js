// lib/ratingsStore.js end to end against a REAL redis-server: the store's own
// key names and argument order, through the real scripts.
//
// ratingScripts.test.js proves the Lua; ratingRoute.test.js proves the route.
// Neither would notice the glue between them going wrong — the two KEYS
// passed in the wrong order would put a viewer's vote in the counters hash
// and a count in their vote hash, and both suites would stay green. So here
// lib/redis is swapped for a thin adapter onto the local server, and the
// store is called exactly as the route calls it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalScript, shouldSkip, startRedis } from './helpers/localRedis';

let server;
let r;

function toObject(flat) {
  if (!flat || !flat.length) return null;
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

// The subset of the Upstash client the ratings store uses, in Upstash's
// calling shapes.
const adapter = {
  eval: (script, keys, args) => evalScript(r, script, keys, args),
  hgetall: async (key) => toObject(await r.call('HGETALL', key)),
  hdel: (key, ...fields) => r.call('HDEL', key, ...fields),
  del: (...keys) => r.call('DEL', ...keys),
  scan: async (cursor, { match, count }) => {
    const [next, keys] = await r.call('SCAN', cursor, 'MATCH', match, 'COUNT', count);
    return [next, keys];
  },
};

// This repo's lib/redis exports the client OBJECT, not a factory.
vi.mock('../redis', () => ({
  redis: adapter,
  k: (name) => `pvp:${name}`,
}));

const store = await import('../ratingsStore');
const { countsByVideo } = await import('../ratings');

describe.skipIf(shouldSkip)('ratings store on a real redis-server', () => {
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

  it('puts the vote in the viewer’s hash and the count in the counters hash', async () => {
    const result = await store.recordRating('a@example.com', 'vid-1', 'up');
    expect(result).toEqual({ ok: true, vote: 'up', changed: true });
    expect(await r.call('HGETALL', 'pvp:ratings:a@example.com')).toEqual(['vid-1', 'up']);
    expect(await r.call('HGETALL', 'pvp:rating_counts')).toEqual(['vid-1:up', '1']);
  });

  it('reads back through the same functions the pages use', async () => {
    await store.recordRating('a@example.com', 'vid-1', 'up');
    await store.recordRating('b@example.com', 'vid-1', 'down');
    await store.recordRating('b@example.com', 'vid-1', null);
    expect(await store.getRatings('a@example.com')).toEqual({ 'vid-1': 'up' });
    expect(await store.getRatings('b@example.com')).toEqual({});
    expect(countsByVideo(await store.getRatingCounts())).toEqual({ 'vid-1': { up: 1, down: 0 } });
  });

  it('forgets a removed viewer: votes out of the totals, progress, saved list and comments gone', async () => {
    const { forgetViewerData } = await import('../viewerData');
    await store.recordRating('a@example.com', 'vid-1', 'up');
    await store.recordRating('b@example.com', 'vid-1', 'up');
    await r.call('HSET', 'pvp:progress:a@example.com', 'vid-1', '{}');
    await r.call('HSET', 'pvp:mylist:a@example.com', 'vid-1', '1');
    const comment = (id, email) => JSON.stringify({ id, email, name: 'N', text: 'hi', at: 1 });
    await r.call('HSET', 'pvp:comments:vid-1', 'caaaaaaa1', comment('caaaaaaa1', 'a@example.com'));
    await r.call('HSET', 'pvp:comments:vid-1', 'caaaaaaa2', comment('caaaaaaa2', 'b@example.com'));
    expect(await forgetViewerData('a@example.com')).toEqual({ votes: 1, comments: 1 });
    expect(countsByVideo(await store.getRatingCounts())).toEqual({ 'vid-1': { up: 1, down: 0 } });
    for (const family of ['ratings', 'progress', 'mylist']) {
      expect(await r.call('EXISTS', `pvp:${family}:a@example.com`), family).toBe(0);
    }
    expect(await r.call('HKEYS', 'pvp:comments:vid-1')).toEqual(['caaaaaaa2']);
    expect(await store.getRatings('b@example.com')).toEqual({ 'vid-1': 'up' });
  });

  it('forgets the stored (lowercase) keys whatever case the address arrives in', async () => {
    const { forgetViewerData } = await import('../viewerData');
    await r.call('HSET', 'pvp:progress:a@example.com', 'vid-1', '{}');
    await r.call('HSET', 'pvp:mylist:a@example.com', 'vid-1', '1');
    await forgetViewerData(' A@Example.com ');
    expect(await r.call('EXISTS', 'pvp:progress:a@example.com')).toBe(0);
    expect(await r.call('EXISTS', 'pvp:mylist:a@example.com')).toBe(0);
  });

  it('reports a repeat as unchanged', async () => {
    await store.recordRating('a@example.com', 'vid-1', 'up');
    expect((await store.recordRating('a@example.com', 'vid-1', 'up')).changed).toBe(false);
  });

  it('recounts from every viewer’s hash and replaces drifted totals', async () => {
    await store.recordRating('a@example.com', 'vid-1', 'up');
    await store.recordRating('b@example.com', 'vid-1', 'up');
    await store.recordRating('b@example.com', 'vid-2', 'down');
    await r.call('HSET', 'pvp:rating_counts', 'vid-1:up', '9', 'ghost:down', '2');
    // A key that is NOT a viewer's ratings hash must not be read as one.
    await r.call('HSET', 'pvp:rating_counts_backup', 'vid-1', 'up');
    expect(await store.recountRatings()).toEqual({ viewers: 2, votes: 3, fields: 2 });
    expect(countsByVideo(await store.getRatingCounts())).toEqual({
      'vid-1': { up: 2, down: 0 },
      'vid-2': { up: 0, down: 1 },
    });
  });

  it('recounts across more viewers than one SCAN page returns', async () => {
    for (let i = 0; i < 450; i++) await store.recordRating(`v${i}@example.com`, 'vid-1', 'up');
    await r.call('DEL', 'pvp:rating_counts');
    expect(await store.recountRatings()).toEqual({ viewers: 450, votes: 450, fields: 1 });
  });
});
