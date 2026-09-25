// pages/api/admin/roles.js — the guards that are the reason the route exists:
// no escalation, someone always able to manage roles, owners not assignable,
// and a role never letting a stranger into the library without viewers:manage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

const state = vi.hoisted(() => ({ session: null, audit: [] }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({ getSession: async () => state.session }));
vi.mock('../audit', () => ({ logAudit: async (...a) => state.audit.push(a) }));
vi.mock('../monitor', () => ({ withMonitorApi: (h) => h }));

const route = (await import('../../pages/api/admin/roles')).default;
const { ALL_CAPABILITIES } = await import('../capabilities');

const role = (id, capabilities, name = id) =>
  mem.hash('pvp:roles').set(id, JSON.stringify({ id, name, capabilities }));
const assign = (email, ids) => mem.hash('pvp:user_roles').set(email, JSON.stringify(ids));
const rolesOf = (email) => JSON.parse(mem.hash('pvp:user_roles').get(email) || '[]');

async function call(method, { body = {}, query = {}, as = 'admin@example.com' } = {}) {
  state.session = as ? { user: { email: as } } : null;
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.setHeader = () => res;
  res.end = () => res;
  await route({ method, body, query, headers: {} }, res);
  return res;
}

// A delegate who can manage roles and hand out media work, nothing more.
function delegate() {
  role('roles-media', ['roles:manage', 'videos:manage']);
  assign('d@x.com', ['roles-media']);
}

beforeEach(() => {
  mem.reset();
  state.audit = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET', () => {
  it('is refused without roles:manage', async () => {
    role('media', ['videos:manage']);
    assign('m@x.com', ['media']);
    expect((await call('GET', { as: 'm@x.com' })).statusCode).toBe(403);
    expect((await call('GET', { as: null })).statusCode).toBe(403);
  });

  it('returns roles, assignments, owners, the catalog and the caller’s own ceiling', async () => {
    delegate();
    const res = await call('GET', { as: 'd@x.com' });
    expect(res.statusCode).toBe(200);
    expect(res.body.roles.map((r) => r.id)).toEqual(['roles-media']);
    expect(res.body.assignments).toEqual({ 'd@x.com': ['roles-media'] });
    expect(res.body.owners).toEqual(['admin@example.com', 'second@example.com']);
    expect(res.body.catalog.map((c) => c.cap).sort()).toEqual([...ALL_CAPABILITIES]);
    expect(res.body.actor).toEqual({ email: 'd@x.com', owner: false, capabilities: ['roles:manage', 'videos:manage'] });
  });

  it('migrates old grants on the way, and audits it once', async () => {
    mem.set('pvp:role_managers').add('m@x.com');
    const res = await call('GET');
    expect(res.body.migrated).toMatchObject({ migrated: 1, roles: ['Manager'] });
    expect(res.body.legacyRemaining).toBe(0);
    expect(rolesOf('m@x.com')).toEqual(['manager-legacy']);
    expect(state.audit.map((a) => a[1])).toEqual(['role.migrate']);
    expect((await call('GET')).body.migrated).toBeNull();
  });
});

describe('creating and editing roles', () => {
  it('lets an owner create any role, dropping unknown capabilities', async () => {
    const res = await call('POST', { body: { name: ' Media  team ', capabilities: ['videos:manage', 'x:y'] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.role).toMatchObject({ name: 'Media team', capabilities: ['videos:manage'] });
    expect(res.body.role.id).toMatch(/^media-team-/);
    expect(state.audit[0][1]).toBe('role.create');
  });

  it('refuses a role without a name', async () => {
    expect((await call('POST', { body: { name: '  ', capabilities: [] } })).statusCode).toBe(400);
  });

  it('refuses a delegate creating a role with a capability they lack, and names it', async () => {
    delegate();
    const res = await call('POST', { as: 'd@x.com', body: { name: 'Up', capabilities: ['settings:manage'] } });
    expect(res.statusCode).toBe(403);
    expect(res.body.refused).toEqual(['settings:manage']);
    expect(mem.hash('pvp:roles').size).toBe(1);
  });

  it('refuses a delegate editing a role above them, even to narrow it', async () => {
    delegate();
    role('boss', ['settings:manage']);
    const res = await call('PUT', { as: 'd@x.com', body: { id: 'boss', name: 'Boss', capabilities: [] } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(mem.hash('pvp:roles').get('boss')).capabilities).toEqual(['settings:manage']);
  });

  it('lets a delegate edit a role within their own capabilities', async () => {
    delegate();
    role('media', ['videos:manage']);
    const res = await call('PUT', { as: 'd@x.com', body: { id: 'media', name: 'Media', capabilities: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.role.capabilities).toEqual([]);
  });

  it('404s an edit to a role that does not exist', async () => {
    expect((await call('PUT', { body: { id: 'ghost', name: 'G', capabilities: [] } })).statusCode).toBe(404);
  });
});

describe('assigning roles', () => {
  it('gives someone roles, approves them as a viewer, and audits by name', async () => {
    role('media', ['videos:manage'], 'Media');
    const res = await call('PATCH', { body: { email: ' New@X.com ', roleIds: ['media', 'ghost'] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.roleIds).toEqual(['media']);
    expect(mem.set('pvp:approved_viewers').has('new@x.com')).toBe(true);
    expect(state.audit[0]).toEqual(['admin@example.com', 'role.assign', 'new@x.com → Media']);
  });

  it('taking every role away leaves them a viewer', async () => {
    role('media', ['videos:manage']);
    assign('p@x.com', ['media']);
    mem.set('pvp:approved_viewers').add('p@x.com');
    expect((await call('PATCH', { body: { email: 'p@x.com', roleIds: [] } })).statusCode).toBe(200);
    expect(mem.hash('pvp:user_roles').has('p@x.com')).toBe(false);
    expect(mem.set('pvp:approved_viewers').has('p@x.com')).toBe(true);
  });

  it('refuses an address that is not an email, and an owner', async () => {
    expect((await call('PATCH', { body: { email: 'nope', roleIds: [] } })).statusCode).toBe(400);
    const res = await call('PATCH', { body: { email: 'Second@Example.com', roleIds: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ADMIN_EMAILS/);
  });

  it('refuses a delegate handing out a role above them', async () => {
    delegate();
    role('boss', ['settings:manage']);
    mem.set('pvp:approved_viewers').add('p@x.com');
    const res = await call('PATCH', { as: 'd@x.com', body: { email: 'p@x.com', roleIds: ['boss'] } });
    expect(res.statusCode).toBe(403);
    expect(rolesOf('p@x.com')).toEqual([]);
  });

  it('refuses a delegate stripping a role above them — demotion is escalation too', async () => {
    delegate();
    role('boss', ['settings:manage']);
    assign('p@x.com', ['boss']);
    const res = await call('PATCH', { as: 'd@x.com', body: { email: 'p@x.com', roleIds: [] } });
    expect(res.statusCode).toBe(403);
    expect(rolesOf('p@x.com')).toEqual(['boss']);
  });

  it('refuses a delegate without viewers:manage letting a stranger in through a role', async () => {
    delegate();
    role('media', ['videos:manage']);
    const res = await call('PATCH', { as: 'd@x.com', body: { email: 'stranger@x.com', roleIds: ['media'] } });
    expect(res.statusCode).toBe(403);
    expect(res.body.refused).toEqual(['viewers:manage']);
    expect(mem.set('pvp:approved_viewers').has('stranger@x.com')).toBe(false);
  });

  it('lets that delegate give the same role to someone already approved', async () => {
    delegate();
    role('media', ['videos:manage']);
    mem.set('pvp:approved_viewers').add('v@x.com');
    expect((await call('PATCH', { as: 'd@x.com', body: { email: 'v@x.com', roleIds: ['media'] } })).statusCode).toBe(
      200
    );
  });

  it('treats an unreadable approval as "not approved"', async () => {
    delegate();
    role('media', ['videos:manage']);
    mem.set('pvp:approved_viewers').add('v@x.com');
    const real = mem.set.bind(mem);
    // Only the approval read fails; everything else still works.
    vi.spyOn(mem, 'set').mockImplementation((key) => {
      if (key === 'pvp:approved_viewers') throw new Error('redis down');
      return real(key);
    });
    const res = await call('PATCH', { as: 'd@x.com', body: { email: 'v@x.com', roleIds: ['media'] } });
    expect(res.statusCode).toBe(403);
  });
});

describe('someone always holds roles:manage', () => {
  // No owners for these: with ADMIN_EMAILS set the guard can never bite.
  beforeEach(() => vi.stubEnv('ADMIN_EMAILS', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('refuses removing roles:manage from its last holder', async () => {
    role('top', ['roles:manage']);
    assign('only@x.com', ['top']);
    const res = await call('PATCH', { as: 'only@x.com', body: { email: 'only@x.com', roleIds: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/nobody able to manage roles/);
    expect(rolesOf('only@x.com')).toEqual(['top']);
  });

  it('refuses editing roles:manage out of the last role that carries it', async () => {
    role('top', ['roles:manage', 'audit:read']);
    assign('only@x.com', ['top']);
    const res = await call('PUT', { as: 'only@x.com', body: { id: 'top', name: 'Top', capabilities: ['audit:read'] } });
    expect(res.statusCode).toBe(400);
  });

  it('refuses deleting the last role that carries it', async () => {
    role('top', ['roles:manage']);
    assign('only@x.com', ['top']);
    expect((await call('DELETE', { as: 'only@x.com', query: { id: 'top' } })).statusCode).toBe(400);
    expect(mem.hash('pvp:roles').has('top')).toBe(true);
  });

  it('allows it once someone else holds roles:manage', async () => {
    role('top', ['roles:manage']);
    assign('only@x.com', ['top']);
    assign('other@x.com', ['top']);
    const res = await call('PATCH', { as: 'only@x.com', body: { email: 'only@x.com', roleIds: [] } });
    expect(res.statusCode).toBe(200);
  });

  it('counts an unmigrated old admin as a holder', async () => {
    role('top', ['roles:manage']);
    assign('only@x.com', ['top']);
    mem.set('pvp:role_admins').add('old@x.com');
    expect((await call('DELETE', { as: 'only@x.com', query: { id: 'top' } })).statusCode).toBe(200);
  });
});

describe('deleting roles', () => {
  it('deletes a role and strips it from its holders', async () => {
    role('media', ['videos:manage']);
    assign('p@x.com', ['media']);
    expect((await call('DELETE', { query: { id: 'media' } })).statusCode).toBe(200);
    expect(mem.hash('pvp:roles').has('media')).toBe(false);
    expect(mem.hash('pvp:user_roles').has('p@x.com')).toBe(false);
    expect(state.audit[0][1]).toBe('role.delete');
  });

  it('refuses a delegate deleting a role above them', async () => {
    delegate();
    role('boss', ['settings:manage']);
    expect((await call('DELETE', { as: 'd@x.com', query: { id: 'boss' } })).statusCode).toBe(403);
    expect(mem.hash('pvp:roles').has('boss')).toBe(true);
  });

  it('is a no-op for a role already gone, and 400s a bad id', async () => {
    expect((await call('DELETE', { query: { id: 'gone' } })).statusCode).toBe(200);
    expect((await call('DELETE', { query: { id: 'a@b.com' } })).statusCode).toBe(400);
  });
});

it('405s an unknown method', async () => {
  expect((await call('OPTIONS')).statusCode).toBe(405);
});

