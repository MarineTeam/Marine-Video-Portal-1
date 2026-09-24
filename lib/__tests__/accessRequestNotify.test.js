import { describe, it, expect, beforeEach, vi } from 'vitest';

// Drives the real pages/api/access-request.js handler through the route
// harness pattern established in apiGates.test.js, because the behaviour worth
// protecting here is not a pure function — it is the "only notify on a
// genuinely NEW request" rule. A viewer refreshing the not-approved page must
// not fire a notification every time.

const state = vi.hoisted(() => ({
  session: null,
  sets: new Map(),
  hashes: new Map(),
  emails: [],
  pushes: [],
  mailOn: true,
  pushOn: true,
  emailThrows: false,
}));

function members(key) {
  if (!state.sets.has(key)) state.sets.set(key, new Set());
  return state.sets.get(key);
}
function hash(key) {
  if (!state.hashes.has(key)) state.hashes.set(key, new Map());
  return state.hashes.get(key);
}

vi.mock('../auth0', () => ({ getSession: async () => state.session }));

vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    sismember: async (key, m) => (members(key).has(m) ? 1 : 0),
    smembers: async (key) => [...members(key)],
    sadd: async (key, ...m) => m.forEach((x) => members(key).add(x)),
    srem: async (key, ...m) => m.forEach((x) => members(key).delete(x)),
    hgetall: async (key) => Object.fromEntries(hash(key)),
    hget: async (key, f) => hash(key).get(f) ?? null,
    hset: async (key, obj) => Object.entries(obj).forEach(([f, v]) => hash(key).set(f, v)),
    hdel: async (key, f) => hash(key).delete(f),
    get: async () => null,
    set: async () => 'OK',
    lpush: async () => 1,
    ltrim: async () => 'OK',
  },
}));

vi.mock('../ratelimit', () => ({ allow: async () => true, callerId: () => 'test' }));

vi.mock('../mail', () => ({
  mailEnabled: () => state.mailOn,
  sendAccessRequestEmail: async (args) => {
    if (state.emailThrows) throw new Error('resend is down');
    state.emails.push(args);
    return true;
  },
}));

vi.mock('../push', () => ({
  pushEnabled: () => state.pushOn,
  sendToEmails: async (emails, payload) => {
    state.pushes.push({ emails, payload });
    return { sent: emails.length, pruned: 0 };
  },
}));

const handler = (await import('../../pages/api/access-request')).default;

function mockRes() {
  const res = { statusCode: null, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  return res;
}

async function post(note) {
  const res = mockRes();
  await handler({ method: 'POST', query: {}, body: { note }, headers: {}, socket: {} }, res);
  return res;
}

beforeEach(() => {
  state.session = { user: { email: 'newcomer@example.com' } };
  state.sets.clear();
  state.hashes.clear();
  state.emails = [];
  state.pushes = [];
  state.mailOn = true;
  state.pushOn = true;
  state.emailThrows = false;
  // One admin via ADMIN_EMAILS (vitest.config.js) plus a manager in Redis.
  members('pvp:role_managers').add('manager@example.com');
});

describe('access request notifications', () => {
  it('notifies on a genuinely new request', async () => {
    const res = await post('Deck crew, Sam sent me');
    expect(res.body).toMatchObject({ ok: true, alreadyPending: false });
    expect(state.emails.length).toBeGreaterThan(0);
    expect(state.pushes).toHaveLength(1);
  });

  // The rule this file exists for: a refresh loop must not become a flood.
  it('does not notify again while the request is still pending', async () => {
    await post('first ask');
    const emailsAfterFirst = state.emails.length;
    const pushesAfterFirst = state.pushes.length;

    const res = await post('second ask');
    expect(res.body).toMatchObject({ alreadyPending: true });
    expect(state.emails).toHaveLength(emailsAfterFirst);
    expect(state.pushes).toHaveLength(pushesAfterFirst);
  });

  it('tells both admins and managers, since both can action it', async () => {
    await post('hello');
    const notified = state.emails.map((e) => e.to);
    expect(notified).toContain('admin@example.com');
    expect(notified).toContain('manager@example.com');
  });

  it('passes the requester and their note through', async () => {
    await post('Deck crew, joined in March');
    expect(state.emails[0]).toMatchObject({
      requesterEmail: 'newcomer@example.com',
      note: 'Deck crew, joined in March',
    });
  });

  // The request is the product; the notification is a convenience.
  it('still records the request when email delivery throws', async () => {
    state.emailThrows = true;
    const res = await post('hello');
    expect(res.statusCode).not.toBe(500);
    expect(res.body).toMatchObject({ ok: true, alreadyPending: false });
    // Push is a separate channel and should still have gone out.
    expect(state.pushes).toHaveLength(1);
  });

  it('is silent and harmless when neither channel is configured', async () => {
    state.mailOn = false;
    state.pushOn = false;
    const res = await post('hello');
    expect(res.body).toMatchObject({ ok: true });
    expect(state.emails).toHaveLength(0);
    expect(state.pushes).toHaveLength(0);
  });

  it('does nothing for someone who is already approved', async () => {
    members('pvp:approved_viewers').add('newcomer@example.com');
    const res = await post('let me in');
    expect(res.body).toMatchObject({ alreadyApproved: true });
    expect(state.emails).toHaveLength(0);
  });
});
