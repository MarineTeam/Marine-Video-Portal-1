import { describe, it, expect, beforeEach, vi } from 'vitest';

// POST /api/progress — what a viewer's player may write. Before these checks
// the route wrote whatever it was sent: any value as the video id, a title of
// any length, and no bound on how many videos one viewer could record. The
// hash's own cap is proved on a real Redis in progressStore.redis.test.js.

const GUID = '0a1b2c3d-0000-4000-8000-000000000001';
const state = vi.hoisted(() => ({ saved: [], allowed: true }));

vi.mock('@auth0/nextjs-auth0', () => ({
  getSession: async () => ({ user: { email: 'Jane@Example.com' } }),
}));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: { sismember: async () => 1, hget: async () => null, hgetall: async () => ({}) },
}));
vi.mock('../roles', () => ({ isStaffUser: async () => false, hasCapability: async () => false }));
vi.mock('../ratelimit', () => ({ allow: async () => state.allowed, callerId: () => 'test' }));
vi.mock('../progressStore', () => ({
  saveProgress: async (email, videoId, entry) => state.saved.push([email, videoId, entry]),
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/progress')).default;

async function post(body) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await route({ method: 'POST', body, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  state.saved = [];
  state.allowed = true;
});

describe('POST /api/progress', () => {
  it('saves a position for a bunny video id, under the session email', async () => {
    const res = await post({ videoId: GUID, seconds: 30.7, duration: 600, title: 'Sunday' });
    expect(res.statusCode).toBe(200);
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0][0]).toBe('jane@example.com');
    expect(state.saved[0][1]).toBe(GUID);
    expect(state.saved[0][2]).toMatchObject({ seconds: 30, duration: 600, title: 'Sunday' });
  });

  it('is still rate limited', async () => {
    state.allowed = false;
    expect((await post({ videoId: GUID, seconds: 1 })).statusCode).toBe(429);
    expect(state.saved).toEqual([]);
  });

  it('refuses anything that is not a bunny video id', async () => {
    for (const videoId of ['vid-1', 'has space', { a: 1 }, ['x'], 5, `${GUID}/..`]) {
      expect((await post({ videoId, seconds: 1 })).statusCode, JSON.stringify(videoId)).toBe(400);
    }
    expect(state.saved).toEqual([]);
  });

  it('refuses a position that is not a real number', async () => {
    for (const seconds of [-1, Infinity, NaN, '10']) {
      expect((await post({ videoId: GUID, seconds })).statusCode, String(seconds)).toBe(400);
    }
  });

  it('bounds the title and keeps only text', async () => {
    await post({ videoId: GUID, seconds: 1, title: 'x'.repeat(5000) });
    await post({ videoId: GUID, seconds: 1, title: { evil: true } });
    expect(state.saved[0][2].title).toHaveLength(200);
    expect(state.saved[1][2].title).toBe('');
  });

  it('stores a nonsense duration as 0 rather than NaN', async () => {
    await post({ videoId: GUID, seconds: 1, duration: 'abc' });
    expect(state.saved[0][2].duration).toBe(0);
  });
});
