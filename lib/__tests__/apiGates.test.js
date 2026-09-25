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
  hashes: new Map(),
}));

function setMembers(key) {
  if (!state.sets.has(key)) state.sets.set(key, new Set());
  return state.sets.get(key);
}

function hash(key) {
  if (!state.hashes.has(key)) state.hashes.set(key, new Map());
  return state.hashes.get(key);
}

vi.mock('../auth0', () => ({
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
    hgetall: async (key) => Object.fromEntries(hash(key)),
    hget: async (key, field) => hash(key).get(field) ?? null,
    hset: async (key, obj) => Object.entries(obj).forEach(([f, v]) => hash(key).set(f, v)),
    hsetnx: async (key, field, v) => (hash(key).has(field) ? 0 : (hash(key).set(field, v), 1)),
    hdel: async (key, ...fields) => fields.forEach((f) => hash(key).delete(f)),
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

const { requireCapability, ALL_CAPABILITIES } = await import('../roles');
const { LEGACY_MANAGER_CAPABILITIES } = await import('../capabilities');

// A custom role holding `caps`, held by `email`.
function giveRole(email, caps, id = 'test-role') {
  hash('pvp:roles').set(id, JSON.stringify({ id, name: id, capabilities: caps }));
  hash('pvp:user_roles').set(email, JSON.stringify([id]));
}

const capOf = (file) =>
  fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8').match(/requireCapability\(req, res, '([^']+)'\)/)?.[1];

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
  state.hashes.clear();
  // A plain approved viewer, and someone holding a custom role with exactly
  // the old Manager's capabilities. 'admin@example.com' is an owner via the
  // ADMIN_EMAILS floor in vitest.config.js — no Redis needed.
  setMembers('pvp:approved_viewers').add('viewer@example.com');
  giveRole('manager@example.com', [...LEGACY_MANAGER_CAPABILITIES], 'manager');
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
    expect(ALL_CAPABILITIES).toContain(match[1]);
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

  it('admits an ADMIN_EMAILS owner with every capability', async () => {
    state.session = sessionFor('admin@example.com');
    const auth = await requireCapability({}, mockRes(), 'roles:manage');
    expect(auth).toMatchObject({ email: 'admin@example.com', owner: true });
    expect(auth.capabilities).toEqual([...ALL_CAPABILITIES]);
  });

  it('admits someone whose custom role holds the capability', async () => {
    state.session = sessionFor('manager@example.com');
    const auth = await requireCapability({}, mockRes(), 'videos:manage');
    expect(auth).toMatchObject({ email: 'manager@example.com', owner: false });
  });

  it('admits an old Manager grant not yet migrated (read-time fallback)', async () => {
    setMembers('pvp:role_managers').add('old@example.com');
    state.session = sessionFor('old@example.com');
    const auth = await requireCapability({}, mockRes(), 'videos:manage');
    expect(auth?.capabilities).toEqual([...LEGACY_MANAGER_CAPABILITIES]);
    expect(await requireCapability({}, mockRes(), 'settings:manage')).toBeNull();
  });

  it('rejects a role holder for a capability outside their roles', async () => {
    state.session = sessionFor('manager@example.com');
    const res = mockRes();
    expect(await requireCapability({}, res, 'settings:manage')).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('matches the caller email case-insensitively', async () => {
    state.session = sessionFor('Manager@Example.com');
    const auth = await requireCapability({}, mockRes(), 'groups:manage');
    expect(auth).toMatchObject({ email: 'manager@example.com' });
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

// The strongest form of the gate test under custom roles: for each route, a
// staff member holding EVERY capability except the one that route names.
describe('each admin route needs its own capability, not just any', () => {
  it.each(ROUTE_FILES)('%s returns 403 to a role holding everything else', async (file) => {
    const cap = capOf(file);
    giveRole('almost@example.com', ALL_CAPABILITIES.filter((c) => c !== cap), 'almost');
    state.session = sessionFor('almost@example.com');
    const mod = await import(path.join(ADMIN_DIR, file));
    const res = mockRes();
    await mod.default({ method: 'GET', query: {}, body: {}, headers: {}, socket: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });
});

describe('what the old Manager could not reach, the migrated Manager role still cannot', () => {
  const adminOnly = ROUTE_FILES.filter((f) => !LEGACY_MANAGER_CAPABILITIES.includes(capOf(f)));

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
