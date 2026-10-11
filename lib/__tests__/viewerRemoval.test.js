// Removing a viewer deletes what was recorded about them (lib/viewerData.js),
// through the real route: their votes come back out of the totals, their
// progress and saved list go, and so do their comments on every video —
// nobody else's. The data goes BEFORE their access, so a failure leaves them
// listed and the removal can simply be tried again. Staff keep their data:
// removing them from this list does not take their access away.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

const state = vi.hoisted(() => ({ email: 'admin@example.com' }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({ getSession: async () => (state.email ? { user: { email: state.email } } : null) }));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../monitor', () => ({ withMonitorApi: (h) => h }));

const route = (await import('../../pages/api/admin/viewers.js')).default;

async function remove(email) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  await route({ method: 'DELETE', query: {}, body: { email }, headers: {} }, res);
  return out;
}

const comment = (videoId, id, email) =>
  mem.hash(`pvp:comments:${videoId}`).set(id, JSON.stringify({ id, email, name: 'N', text: 'hi', at: 1 }));
const counts = () => Object.fromEntries(mem.hash('pvp:rating_counts'));

function seed(email) {
  mem.set('pvp:approved_viewers').add(email);
  mem.hash(`pvp:progress:${email}`).set('v1', JSON.stringify({ seconds: 30 }));
  mem.hash(`pvp:mylist:${email}`).set('v1', '1');
  mem.hash(`pvp:ratings:${email}`).set('v1', 'up');
  mem.hash(`pvp:ratings:${email}`).set('v2', 'down');
}

beforeEach(() => {
  mem.reset();
  state.email = 'admin@example.com';
  seed('gone@x.com');
  seed('stays@x.com');
  mem.hash('pvp:rating_counts').set('v1:up', 2);
  mem.hash('pvp:rating_counts').set('v2:down', 2);
  comment('v1', 'caaaaaaa1', 'gone@x.com');
  comment('v1', 'caaaaaaa2', 'stays@x.com');
  comment('v2', 'caaaaaaa3', 'Gone@X.com');
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('removing a viewer', () => {
  it('deletes their votes from the totals, their progress, saved list and comments', async () => {
    const res = await remove('gone@x.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toEqual({ votes: 2, comments: 2 });
    expect(counts()).toEqual({ 'v1:up': 1, 'v2:down': 1 });
    for (const family of ['progress', 'mylist', 'ratings']) {
      expect(mem.hashes.has(`pvp:${family}:gone@x.com`), family).toBe(false);
    }
    expect([...mem.hash('pvp:comments:v1').keys()]).toEqual(['caaaaaaa2']);
    expect(mem.hash('pvp:comments:v2').size).toBe(0);
    expect(mem.set('pvp:approved_viewers').has('gone@x.com')).toBe(false);
  });

  it('leaves everyone else’s data alone', async () => {
    await remove('gone@x.com');
    expect(mem.hash('pvp:progress:stays@x.com').size).toBe(1);
    expect(mem.hash('pvp:mylist:stays@x.com').size).toBe(1);
    expect(mem.hash('pvp:ratings:stays@x.com').size).toBe(2);
  });

  it('keeps them listed when their data cannot be deleted, so it can be retried', async () => {
    const realHash = mem.hash.bind(mem);
    vi.spyOn(mem, 'hash').mockImplementation((key) => {
      if (key.startsWith('pvp:comments:')) throw new Error('redis down');
      return realHash(key);
    });
    const res = await remove('gone@x.com');
    expect(res.statusCode).toBe(502);
    vi.restoreAllMocks();
    expect(mem.set('pvp:approved_viewers').has('gone@x.com')).toBe(true);
    expect((await remove('gone@x.com')).statusCode).toBe(200);
    expect(mem.hash('pvp:comments:v1').has('caaaaaaa1')).toBe(false);
  });

  it('keeps the data of staff, whose access the list does not decide', async () => {
    mem.hash('pvp:roles').set('mod', JSON.stringify({ id: 'mod', name: 'Mod', capabilities: ['comments:manage'] }));
    mem.hash('pvp:user_roles').set('gone@x.com', JSON.stringify(['mod']));
    const res = await remove('gone@x.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toBeNull();
    expect(mem.hash('pvp:progress:gone@x.com').size).toBe(1);
    seed('second@example.com');
    expect((await remove('second@example.com')).body.forgotten).toBeNull();
  });

  it('removes nobody, and deletes nothing, when it cannot tell who is staff', async () => {
    // The caller is an owner, whose access is decided without Redis; it is
    // the staff list for the person being removed that cannot be read.
    const realHash = mem.hash.bind(mem);
    vi.spyOn(mem, 'hash').mockImplementation((key) => {
      if (key === 'pvp:user_roles') throw new Error('redis down');
      return realHash(key);
    });
    expect((await remove('gone@x.com')).statusCode).toBe(502);
    vi.restoreAllMocks();
    expect(mem.set('pvp:approved_viewers').has('gone@x.com')).toBe(true);
    expect(mem.hash('pvp:ratings:gone@x.com').size).toBe(2);
    expect(counts()).toEqual({ 'v1:up': 2, 'v2:down': 2 });
  });
});
