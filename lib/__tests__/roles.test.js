// lib/roles.js and lib/roleMigration.js — resolving what someone may do, and
// carrying the old fixed Admin / Manager grants onto custom roles.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({ getSession: async () => null }));

const roles = await import('../roles');
const { LEGACY_MANAGER_CAPABILITIES, ALL_CAPABILITIES } = await import('../capabilities');
const { migrateLegacyRoles, legacyCapabilitiesFor } = await import('../roleMigration');

const role = (id, capabilities, name = id) =>
  mem.hash('pvp:roles').set(id, JSON.stringify({ id, name, capabilities }));
const assign = (email, ids) => mem.hash('pvp:user_roles').set(email, JSON.stringify(ids));

beforeEach(() => {
  mem.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveCapabilities', () => {
  it('gives an ADMIN_EMAILS owner everything without reading Redis', async () => {
    mem.failing = true;
    expect(await roles.resolveCapabilities('Admin@Example.com')).toEqual([...ALL_CAPABILITIES]);
  });

  it('is the union of the roles someone holds', async () => {
    role('media', ['videos:manage']);
    role('insight', ['analytics:read', 'audit:read']);
    assign('a@x.com', ['media', 'insight']);
    expect(await roles.resolveCapabilities('A@X.com')).toEqual(['analytics:read', 'audit:read', 'videos:manage']);
  });

  it('ignores a stored capability the catalog does not know', async () => {
    role('odd', ['videos:manage', 'everything:all']);
    assign('a@x.com', ['odd']);
    expect(await roles.resolveCapabilities('a@x.com')).toEqual(['videos:manage']);
  });

  it('gives nothing to someone with no roles, or only deleted ones', async () => {
    assign('a@x.com', ['gone']);
    expect(await roles.resolveCapabilities('a@x.com')).toEqual([]);
    expect(await roles.resolveCapabilities('nobody@x.com')).toEqual([]);
    expect(await roles.resolveCapabilities('')).toEqual([]);
  });

  it('fails CLOSED for everyone but owners when Redis is down', async () => {
    role('media', ['videos:manage']);
    assign('a@x.com', ['media']);
    mem.failing = true;
    expect(await roles.resolveCapabilities('a@x.com')).toEqual([]);
    expect(await roles.isStaffUser('a@x.com')).toBe(false);
  });

  it('still honours an old grant nobody has migrated yet', async () => {
    mem.set('pvp:role_managers').add('m@x.com');
    mem.set('pvp:role_admins').add('a@x.com');
    expect(await roles.resolveCapabilities('m@x.com')).toEqual([...LEGACY_MANAGER_CAPABILITIES]);
    expect(await roles.resolveCapabilities('a@x.com')).toEqual([...ALL_CAPABILITIES]);
  });
});

describe('getAccess / isStaffUser / hasCapability', () => {
  it('counts anyone holding a capability as staff, and nobody else', async () => {
    role('mod', ['comments:manage']);
    assign('mod@x.com', ['mod']);
    role('empty', []);
    assign('e@x.com', ['empty']);
    expect(await roles.getAccess('mod@x.com')).toEqual({
      email: 'mod@x.com',
      owner: false,
      staff: true,
      capabilities: ['comments:manage'],
      staffScope: null,
      contentScope: null,
    });
    expect(await roles.isStaffUser('e@x.com')).toBe(false);
    expect(await roles.hasCapability('mod@x.com', 'comments:manage')).toBe(true);
    expect(await roles.hasCapability('mod@x.com', 'viewers:manage')).toBe(false);
    expect((await roles.getAccess('admin@example.com')).owner).toBe(true);
  });
});

describe('storage', () => {
  it('deleting a role strips it from everyone who held it', async () => {
    role('a', ['audit:read']);
    role('b', ['videos:manage']);
    assign('one@x.com', ['a', 'b']);
    assign('two@x.com', ['a']);
    await roles.deleteRole('a');
    expect(await roles.loadRoleAssignments()).toEqual({ 'one@x.com': ['b'] });
  });

  it('stores only live role ids for a person, and clears them with an empty list', async () => {
    role('a', ['audit:read']);
    const rolesById = await roles.loadRoles();
    expect((await roles.setRolesForEmail('P@x.com', ['a', 'ghost', 'a'], rolesById)).roleIds).toEqual(['a']);
    expect(await roles.rolesForEmail('p@x.com')).toEqual(['a']);
    await roles.setRolesForEmail('p@x.com', [], rolesById);
    expect(mem.hash('pvp:user_roles').has('p@x.com')).toBe(false);
  });

  it('skips a stored role that does not parse', async () => {
    mem.hash('pvp:roles').set('broken', '{nope');
    mem.hash('pvp:roles').set('a@b.com', JSON.stringify({ name: 'x', capabilities: [] }));
    role('ok', ['audit:read']);
    expect(Object.keys(await roles.loadRoles())).toEqual(['ok']);
  });
});

describe('who holds what', () => {
  it('lists owners, role holders with a capability, and unmigrated grants as staff', async () => {
    role('a', ['audit:read']);
    role('empty', []);
    assign('r@x.com', ['a']);
    assign('e@x.com', ['empty']);
    mem.set('pvp:role_managers').add('old@x.com');
    expect(await roles.listStaffEmails()).toEqual([
      'admin@example.com',
      'old@x.com',
      'r@x.com',
      'second@example.com',
    ]);
  });

  it('throws from listStaffEmails when Redis is down, so the sweep stops', async () => {
    mem.failing = true;
    await expect(roles.listStaffEmails()).rejects.toThrow();
  });

  it('addresses a notification at exactly the holders, owners on a failure', async () => {
    role('people', ['viewers:manage']);
    role('media', ['videos:manage']);
    assign('p@x.com', ['people']);
    assign('m@x.com', ['media']);
    expect(await roles.emailsHoldingCapability('viewers:manage')).toEqual([
      'admin@example.com',
      'p@x.com',
      'second@example.com',
    ]);
    mem.failing = true;
    expect(await roles.emailsHoldingCapability('viewers:manage')).toEqual([
      'admin@example.com',
      'second@example.com',
    ]);
  });
});

describe('migrateLegacyRoles', () => {
  it('turns the old tiers into editable roles, assigns them, then empties the old sets', async () => {
    mem.set('pvp:role_admins').add('a@x.com');
    mem.set('pvp:role_managers').add('m@x.com');
    const summary = await migrateLegacyRoles();
    expect(summary).toMatchObject({ migrated: 2, roles: ['Admin', 'Manager'], emails: ['a@x.com', 'm@x.com'] });
    const rolesById = await roles.loadRoles();
    expect(rolesById['admin-legacy']).toMatchObject({ name: 'Admin', capabilities: [...ALL_CAPABILITIES] });
    expect(rolesById['manager-legacy']).toMatchObject({
      name: 'Manager',
      capabilities: [...LEGACY_MANAGER_CAPABILITIES],
    });
    expect(await roles.loadRoleAssignments()).toEqual({
      'a@x.com': ['admin-legacy'],
      'm@x.com': ['manager-legacy'],
    });
    expect(mem.set('pvp:role_admins').size).toBe(0);
    expect(mem.set('pvp:role_managers').size).toBe(0);
    // Nobody's permissions moved.
    expect(await roles.resolveCapabilities('m@x.com')).toEqual([...LEGACY_MANAGER_CAPABILITIES]);
    expect(await roles.resolveCapabilities('a@x.com')).toEqual([...ALL_CAPABILITIES]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    mem.set('pvp:role_managers').add('m@x.com');
    await migrateLegacyRoles();
    const before = JSON.stringify([...mem.hash('pvp:roles'), ...mem.hash('pvp:user_roles')]);
    expect((await migrateLegacyRoles()).migrated).toBe(0);
    expect(JSON.stringify([...mem.hash('pvp:roles'), ...mem.hash('pvp:user_roles')])).toBe(before);
  });

  it('keeps a custom role someone already holds, and an edit made to a migrated role', async () => {
    role('media', ['videos:manage']);
    assign('m@x.com', ['media']);
    role('manager-legacy', ['audit:read'], 'Renamed');
    mem.set('pvp:role_managers').add('m@x.com');
    await migrateLegacyRoles();
    expect(await roles.rolesForEmail('m@x.com')).toEqual(['manager-legacy', 'media']);
    expect((await roles.loadRoles())['manager-legacy'].name).toBe('Renamed');
  });

  it('converts someone in both old sets as an admin and clears both', async () => {
    mem.set('pvp:role_admins').add('both@x.com');
    mem.set('pvp:role_managers').add('both@x.com');
    await migrateLegacyRoles();
    expect(await roles.rolesForEmail('both@x.com')).toEqual(['admin-legacy']);
    expect(mem.set('pvp:role_managers').size).toBe(0);
    expect(await legacyCapabilitiesFor('both@x.com')).toEqual([]);
  });

  it('has nothing to do on a store that never had old grants', async () => {
    expect(await migrateLegacyRoles()).toEqual({ migrated: 0, roles: [], emails: [] });
    expect(mem.hash('pvp:roles').size).toBe(0);
  });
});
