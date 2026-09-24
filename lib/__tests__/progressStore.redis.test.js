// saveProgress (lib/progressStore.js) against a REAL redis-server: the capped write
// script, and the eviction path when a new video arrives at the cap.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalScript, shouldSkip, startRedis } from './helpers/localRedis';

let server;
let r;

const parse = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// The subset of the Upstash client saveProgress uses, in Upstash's shapes
// (it JSON-encodes object values and parses them back on read).
const adapter = {
  eval: (script, keys, args) => evalScript(r, script, keys, args),
  hgetall: async (key) => {
    const flat = await r.call('HGETALL', key);
    if (!flat.length) return null;
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = parse(flat[i + 1]);
    return out;
  },
  hdel: (key, ...fields) => r.call('HDEL', key, ...fields),
  hset: (key, obj) =>
    r.call('HSET', key, ...Object.entries(obj).flatMap(([f, v]) => [f, typeof v === 'string' ? v : JSON.stringify(v)])),
};

vi.mock('../redis', () => ({
  redis: adapter,
  k: (name) => `pvp:${name}`,
}));

const { saveProgress } = await import('../progressStore');
const { MAX_PROGRESS_ENTRIES } = await import('../progress');

const KEY = 'pvp:progress:jane@example.com';
const at = (n) => Date.UTC(2026, 0, 1) + n * 60_000;

async function fill(n) {
  const args = [];
  for (let i = 0; i < n; i += 1) args.push(`v${i}`, JSON.stringify({ seconds: 1, duration: 10, at: at(i) }));
  await r.call('HSET', KEY, ...args);
}

describe.skipIf(shouldSkip)('saveProgress on a real redis-server', () => {
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

  it('writes an entry that reads back as it was saved', async () => {
    const entry = { seconds: 30, duration: 600, title: 'Sunday', at: at(1) };
    await saveProgress('jane@example.com', 'vid-1', entry);
    expect(await adapter.hgetall(KEY)).toEqual({ 'vid-1': entry });
  });

  it('updates a video already at the cap without evicting anything', async () => {
    await fill(MAX_PROGRESS_ENTRIES);
    await saveProgress('jane@example.com', 'v500', { seconds: 99, duration: 10, at: at(5000) });
    expect(Number(await r.call('HLEN', KEY))).toBe(MAX_PROGRESS_ENTRIES);
    expect(parse(await r.call('HGET', KEY, 'v500')).seconds).toBe(99);
    // The least recently watched entry is still there: nothing was evicted.
    expect(await r.call('HEXISTS', KEY, 'v0')).toBe(1);
  });

  it('makes room for a new video at the cap by dropping the least recently watched', async () => {
    await fill(MAX_PROGRESS_ENTRIES);
    await saveProgress('jane@example.com', 'brand-new', { seconds: 5, duration: 10, at: at(5000) });
    expect(Number(await r.call('HLEN', KEY))).toBe(MAX_PROGRESS_ENTRIES);
    expect(await r.call('HEXISTS', KEY, 'brand-new')).toBe(1);
    expect(await r.call('HEXISTS', KEY, 'v0')).toBe(0);
    expect(await r.call('HEXISTS', KEY, 'v1')).toBe(1);
  });

  it('trims an over-full hash back under the cap', async () => {
    await fill(MAX_PROGRESS_ENTRIES + 3);
    await saveProgress('jane@example.com', 'brand-new', { seconds: 5, duration: 10, at: at(5000) });
    expect(Number(await r.call('HLEN', KEY))).toBe(MAX_PROGRESS_ENTRIES);
  });
});
