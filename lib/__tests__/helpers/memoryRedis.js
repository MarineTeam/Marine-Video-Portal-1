// An in-memory stand-in for lib/redis.js covering the set and hash commands
// the role system uses, for route and store tests that need state to persist
// across calls. Values are stored as given — the role code writes JSON
// strings, and reads them back parsed or not, as Upstash may do either.
//
// Use from a test:
//
//   vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
//   import { mem } from './helpers/memoryRedis';
//   beforeEach(() => mem.reset());
//
// `mem.failing = true` makes every command throw, for fail-closed tests.
export const mem = {
  sets: new Map(),
  hashes: new Map(),
  strings: new Map(),
  failing: false,
  reset() {
    this.sets.clear();
    this.hashes.clear();
    this.strings.clear();
    this.failing = false;
  },
  set(key) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key);
  },
  hash(key) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key);
  },
};

function guard() {
  if (mem.failing) throw new Error('redis down');
}

const redis = {
  sismember: async (key, m) => (guard(), mem.set(key).has(m) ? 1 : 0),
  smembers: async (key) => (guard(), [...mem.set(key)]),
  sadd: async (key, ...ms) => (guard(), ms.forEach((m) => mem.set(key).add(m)), ms.length),
  srem: async (key, ...ms) => (guard(), ms.forEach((m) => mem.set(key).delete(m)), ms.length),
  hgetall: async (key) => (guard(), mem.hash(key).size ? Object.fromEntries(mem.hash(key)) : null),
  hget: async (key, f) => (guard(), mem.hash(key).get(f) ?? null),
  hset: async (key, obj) => (guard(), Object.entries(obj).forEach(([f, v]) => mem.hash(key).set(f, v)), 1),
  hsetnx: async (key, f, v) => {
    guard();
    if (mem.hash(key).has(f)) return 0;
    mem.hash(key).set(f, v);
    return 1;
  },
  hdel: async (key, ...fs) => (guard(), fs.forEach((f) => mem.hash(key).delete(f)), fs.length),
  get: async (key) => (guard(), mem.strings.get(key) ?? null),
  mget: async (...keys) => (guard(), keys.map((key) => mem.strings.get(key) ?? null)),
  set: async (key, v) => (guard(), mem.strings.set(key, v), 'OK'),
  del: async (...keys) => (guard(), keys.forEach((key) => (mem.strings.delete(key), mem.sets.delete(key), mem.hashes.delete(key))), keys.length),
  expire: async () => 1,
  pipeline() {
    const queued = [];
    const p = {
      set: (...a) => (queued.push(() => redis.set(...a)), p),
      del: (...a) => (queued.push(() => redis.del(...a)), p),
      sadd: (...a) => (queued.push(() => redis.sadd(...a)), p),
      srem: (...a) => (queued.push(() => redis.srem(...a)), p),
      exec: async () => Promise.all(queued.map((f) => f())),
    };
    return p;
  },
  lpush: async () => 1,
  ltrim: async () => 'OK',
  lrange: async () => [],
};

export const redisModule = { redis, k: (key) => `pvp:${key}` };
