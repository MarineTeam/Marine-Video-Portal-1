import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Route-handler tests. NOTE: this is a NEW practice in this repo, not an
// existing convention — until now only pure lib/ logic was unit-tested, and
// `validation-and-qa` explicitly listed a handler harness as a candidate
// improvement rather than something we did. It is deliberately narrow: it
// proves the AUTHORIZATION GATE on every admin route and nothing else. The
// bodies of those handlers talk to Bunny, Redis and Auth0 for real and still
// belong to the manual E2E checklists — mocking them here would produce
// tests that pass while production breaks, which is exactly the failure mode
// the evidence ladder exists to prevent.

// vi.mock factories are hoisted above imports, so mutable state they close
// over has to be hoisted too.
const state = vi.hoisted(() => ({
  session: null,
  sets: new Map(),
}));

function setMembers(key) {
  if (!state.sets.has(key)) state.sets.set(key, new Set());
  return state.sets.get(key);
}

vi.mock('@auth0/nextjs-auth0', () => ({
  getSession: async () => state.session,
}));

// Stand-in for lib/redis.js. Every admin route reaches it (directly, or via
// lib/audit.js and lib/roles.js), and the real module builds an Upstash
// client at import time.
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    sismember: async (key, member) => (setMembers(key).has(member) ? 1 : 0),
    smembers: async (key) => [...setMembers(key)],
    sadd: async (key, ...m) => m.forEach((x) => setMembers(key).add(x)),
    srem: async (key, ...m) => m.forEach((x) => setMembers(key).delete(x)),
    hgetall: async () => ({}),
    hget: async () => null,
    hset: async () => 1,
    hdel: async () => 1,
    get: async () => null,
    set: async () => 'OK',
    lpush: async () => 1,
    ltrim: async () => 'OK',
    lrange: async () => [],
    keys: async () => [],
    del: async () => 1,
  },
}));

// The real limiter constructs an @upstash/ratelimit instance at module load
// against the (now mocked) redis client. Rate limiting isn't what's under
// test; a gate must reject before the limiter is even consulted.
vi.mock('../ratelimit', () => ({
  allow: async () => true,
  callerId: () => 'test',
}));

const { requireCapability, CAPABILITIES, ROLE_ADMIN, ROLE_MANAGER } = await import('../roles');

const ADMIN_DIR = path.join(process.cwd(), 'pages/api/admin');
const ROUTE_FILES = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.js')).sort();

function sessionFor(email) {
  return { user: { email } };
}

function mockRes() {
  const res = { statusCode: null, body: undefined, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => { res.ended = true; return res; };
  res.setHeader = () => res;
  return res;
}

beforeEach(() => {
  state.session = null;
  state.sets.clear();
  // A plain approved viewer, and a manager granted in Redis. 'admin@example.com'
  // is an admin via the ADMIN_EMAILS floor in vitest.config.js — no Redis needed.
  setMembers('pvp:approved_viewers').add('viewer@example.com');
  setMembers('pvp:role_managers').add('manager@example.com');
});

// --- Static invariants: no ungated route can be added without failing here ---

describe('every admin route ships gated', () => {
  it('finds the admin routes', () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(18);
  });

  it.each(ROUTE_FILES)('%s calls requireCapability with a known capability', (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
    const match = src.match(/requireCapability\(req, res, '([^']+)'\)/);
    expect(match, `${file} has no requireCapability gate`).not.toBeNull();
    expect(Object.keys(CAPABILITIES)).toContain(match[1]);
  });

  it.each(ROUTE_FILES)('%s returns early when the gate rejects', (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
    // Without this the handler would fall through and run unauthenticated.
    expect(src).toMatch(/if \(!auth\) return;/);
  });

  it.each(ROUTE_FILES)('%s does not carry a legacy isAdmin gate', (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
    expect(src).not.toMatch(/!isAdmin\(/);
  });
});

// --- Behavioural: the gate itself ---

describe('requireCapability', () => {
  it('rejects a caller with no session', async () => {
    const res = mockRes();
    expect(await requireCapability({}, res, 'videos:manage')).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('rejects a session with no email', async () => {
    state.session = { user: {} };
    const res = mockRes();
    expect(await requireCapability({}, res, 'videos:manage')).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('rejects an approved viewer', async () => {
    state.session = sessionFor('viewer@example.com');
    const res = mockRes();
    expect(await requireCapability({}, res, 'videos:manage')).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('admits an ADMIN_EMAILS admin without consulting Redis', async () => {
    state.session = sessionFor('admin@example.com');
    const auth = await requireCapability({}, mockRes(), 'roles:manage');
    expect(auth).toMatchObject({ email: 'admin@example.com', role: ROLE_ADMIN });
  });

  it('admits a Redis-granted manager for a manager capability', async () => {
    state.session = sessionFor('manager@example.com');
    const auth = await requireCapability({}, mockRes(), 'videos:manage');
    expect(auth).toMatchObject({ email: 'manager@example.com', role: ROLE_MANAGER });
  });

  it('rejects a manager for an admin-only capability', async () => {
    state.session = sessionFor('manager@example.com');
    const res = mockRes();
    expect(await requireCapability({}, res, 'settings:manage')).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('matches the caller email case-insensitively', async () => {
    state.session = sessionFor('Manager@Example.com');
    const auth = await requireCapability({}, mockRes(), 'groups:manage');
    expect(auth).toMatchObject({ role: ROLE_MANAGER });
  });

  // The message must not tell a caller which role would have worked.
  it('never reveals the required role', async () => {
    state.session = sessionFor('viewer@example.com');
    const res = mockRes();
    await requireCapability({}, res, 'settings:manage');
    expect(JSON.stringify(res.body)).not.toMatch(/admin|manager|settings/i);
  });
});

// --- Behavioural: the real handlers, end to end through the gate ---

describe('admin routes reject an approved viewer', () => {
  it.each(ROUTE_FILES)('%s returns 403', async (file) => {
    state.session = sessionFor('viewer@example.com');
    const mod = await import(path.join(ADMIN_DIR, file));
    const res = mockRes();
    await mod.default({ method: 'GET', query: {}, body: {}, headers: {}, socket: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });
});

describe('admin routes reject a signed-out caller', () => {
  it.each(ROUTE_FILES)('%s returns 403', async (file) => {
    state.session = null;
    const mod = await import(path.join(ADMIN_DIR, file));
    const res = mockRes();
    await mod.default({ method: 'GET', query: {}, body: {}, headers: {}, socket: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('admin-only routes reject a manager', () => {
  const adminOnly = ROUTE_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, f), 'utf8');
    const cap = src.match(/requireCapability\(req, res, '([^']+)'\)/)?.[1];
    return cap && !CAPABILITIES[cap].includes(ROLE_MANAGER);
  });

  it('covers the admin-only surface', () => {
    expect(adminOnly).toEqual(
      expect.arrayContaining(['broadcast.js', 'geo.js', 'maintenance.js', 'roles.js', 'settings.js', 'watermark.js'])
    );
  });

  it.each(adminOnly)('%s returns 403 for a manager', async (file) => {
    state.session = sessionFor('manager@example.com');
    const mod = await import(path.join(ADMIN_DIR, file));
    const res = mockRes();
    await mod.default({ method: 'GET', query: {}, body: {}, headers: {}, socket: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});
