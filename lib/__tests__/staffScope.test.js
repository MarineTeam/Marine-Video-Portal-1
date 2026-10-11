// Group-scoped staff: the pure rules, what getAccess makes of a stored scope,
// what a scoped staff member sees in the library, and who still counts as
// able to manage roles.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({ getSession: async () => null }));

const rules = await import('../staffScopeRules');
const { CAP, ALL_CAPABILITIES } = await import('../capabilities');
const { getAccess, holdersOf } = await import('../roles');
const { resolveAccess } = await import('../groups');

const groupsById = {
  youth: { id: 'youth', name: 'Youth', collectionIds: ['sermons'], videoIds: ['v1', 'v3'] },
  deck: { id: 'deck', name: 'Deck', collectionIds: [], videoIds: ['v2', 'v3'] },
};
const scoped = (scope) => ({ staffScope: scope, contentScope: rules.contentOfScope(scope, groupsById) });
const unscoped = { staffScope: null, contentScope: null };

describe('the pure rules', () => {
  it('strips exactly the portal-wide capabilities, even for a scope of no groups', () => {
    expect(rules.GLOBAL_CAPABILITIES).toEqual([CAP.SETTINGS_MANAGE, CAP.ROLES_MANAGE, CAP.AUDIT_READ]);
    expect(rules.capabilitiesUnderScope(ALL_CAPABILITIES, ['youth'])).toHaveLength(ALL_CAPABILITIES.length - 3);
    expect(rules.capabilitiesUnderScope([CAP.SETTINGS_MANAGE, CAP.VIDEOS_MANAGE], [])).toEqual([CAP.VIDEOS_MANAGE]);
    expect(rules.capabilitiesUnderScope(ALL_CAPABILITIES, null)).toHaveLength(ALL_CAPABILITIES.length);
  });

  it('keeps null as null and anything else as a list', () => {
    expect(rules.normalizeScope(null)).toBeNull();
    expect(rules.normalizeScope([])).toEqual([]);
    expect(rules.normalizeScope('youth')).toEqual([]);
    expect(rules.normalizeScope(['youth', 'youth', 'Bad Id!', 'deck'])).toEqual(['deck', 'youth']);
  });

  it('reaches what the scope’s existing groups grant — always restricted', () => {
    expect(rules.contentOfScope(['youth', 'gone'], groupsById)).toEqual({
      restricted: true,
      groupIds: ['youth'],
      collectionIds: ['sermons'],
      videoIds: ['v1', 'v3'],
    });
    expect(rules.contentOfScope([], groupsById)).toEqual({
      restricted: true,
      groupIds: [],
      collectionIds: [],
      videoIds: [],
    });
  });

  it('puts videos in scope by id or by collection, and nothing without a content scope', () => {
    const a = scoped(['youth']);
    expect(rules.videoInScope(a, { guid: 'v1' })).toBe(true);
    expect(rules.videoInScope(a, { guid: 'v9', collectionId: 'sermons' })).toBe(true);
    expect(rules.videoInScope(a, { guid: 'v2' })).toBe(false);
    expect(rules.videoInScope({ staffScope: ['youth'], contentScope: null }, { guid: 'v1' })).toBe(false);
    expect(rules.videoInScope(unscoped, { guid: 'anything' })).toBe(true);
  });

  it('puts people in scope by a group they share with it', () => {
    const a = scoped(['youth']);
    expect(rules.personInScope(a, ['youth'], groupsById)).toBe(true);
    expect(rules.personInScope(a, ['deck'], groupsById)).toBe(false);
    expect(rules.personInScope(a, [], groupsById)).toBe(false);
  });

  it('knows when a change leaves someone in no group — deleted groups do not count', () => {
    expect(rules.leavesNoGroup([], groupsById)).toBe(true);
    expect(rules.leavesNoGroup(['gone'], groupsById)).toBe(true);
    expect(rules.leavesNoGroup(['deck'], groupsById)).toBe(false);
  });

  it('removes a person, or deletes a video, only when every group involved is theirs', () => {
    const a = scoped(['youth']);
    expect(rules.mayRemovePerson(a, ['youth'], groupsById)).toBe(true);
    expect(rules.mayRemovePerson(a, ['youth', 'deck'], groupsById)).toBe(false);
    expect(rules.mayRemovePerson(a, [], groupsById)).toBe(false);
    expect(rules.mayDeleteVideo(a, { guid: 'v1' }, groupsById)).toBe(true);
    expect(rules.mayDeleteVideo(a, { guid: 'v3' }, groupsById)).toBe(false);
    expect(rules.mayDeleteVideo(a, { guid: 'v2' }, groupsById)).toBe(false);
  });

  it('lets a scoped caller change only their own groups’ publish windows', () => {
    const a = scoped(['youth']);
    const w = { publishAt: 1 };
    expect(rules.scheduleGroupsProblem(a, { deck: w }, { deck: w, youth: w }, groupsById)).toBeNull();
    expect(rules.scheduleGroupsProblem(a, { deck: w }, { youth: w }, groupsById)).toMatch(/your own groups/);
    expect(rules.scheduleGroupsProblem(a, null, { deck: w }, groupsById)).toMatch(/your own groups/);
    expect(rules.scheduleGroupsProblem(unscoped, null, { deck: w }, groupsById)).toBeNull();
  });

  it('places new people in the named group if it is theirs, else their only one', () => {
    expect(rules.placementGroup(scoped(['youth']), undefined, groupsById)).toBe('youth');
    expect(rules.placementGroup(scoped(['youth', 'deck']), undefined, groupsById)).toBeNull();
    expect(rules.placementGroup(scoped(['youth', 'deck']), 'deck', groupsById)).toBe('deck');
    expect(rules.placementGroup(scoped(['youth']), 'deck', groupsById)).toBeNull();
    expect(rules.placementGroup(scoped(['gone']), undefined, groupsById)).toBeNull();
    expect(rules.placementGroup(unscoped, 'deck', groupsById)).toBeUndefined();
  });
});

function world() {
  const groups = mem.hash('pvp:groups');
  for (const g of Object.values(groupsById)) groups.set(g.id, JSON.stringify({ ...g, createdAt: 1 }));
  mem.hash('pvp:roles').set(
    'staff',
    JSON.stringify({ id: 'staff', name: 'Staff', capabilities: ['videos:manage', 'settings:manage', 'roles:manage'] })
  );
  mem.hash('pvp:user_roles').set('s@x.com', JSON.stringify(['staff']));
}

// Every read of the scope hash fails; everything else works.
function scopeUnreadable() {
  const real = mem.hash.bind(mem);
  vi.spyOn(mem, 'hash').mockImplementation((key) => {
    if (key === 'pvp:user_scope') throw new Error('redis down');
    return real(key);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mem.reset();
  world();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getAccess with a scope', () => {
  it('leaves an unscoped staff member as before', async () => {
    const access = await getAccess('s@x.com');
    expect(access.staffScope).toBeNull();
    expect(access.contentScope).toBeNull();
    expect(access.capabilities).toContain('settings:manage');
  });

  it('strips portal-wide capabilities and records the content the scope reaches', async () => {
    mem.hash('pvp:user_scope').set('s@x.com', JSON.stringify(['youth']));
    const access = await getAccess('s@x.com');
    expect(access.staffScope).toEqual(['youth']);
    expect(access.capabilities).toEqual(['videos:manage']);
    expect(access.contentScope.videoIds).toEqual(['v1', 'v3']);
  });

  it('reads an unparseable stored scope as no groups, never as unscoped', async () => {
    mem.hash('pvp:user_scope').set('s@x.com', '{nope');
    const access = await getAccess('s@x.com');
    expect(access.staffScope).toEqual([]);
    expect(access.capabilities).toEqual(['videos:manage']);
    expect(access.contentScope.videoIds).toEqual([]);
  });

  it('gives no capabilities at all when the scope cannot be read', async () => {
    scopeUnreadable();
    const access = await getAccess('s@x.com');
    expect(access.capabilities).toEqual([]);
    expect(access.staff).toBe(false);
  });

  it('ignores any scope stored for an owner', async () => {
    mem.hash('pvp:user_scope').set('admin@example.com', JSON.stringify(['youth']));
    const access = await getAccess('admin@example.com');
    expect(access.staffScope).toBeNull();
    expect(access.capabilities).toEqual([...ALL_CAPABILITIES]);
  });
});

describe('resolveAccess for a scoped staff member', () => {
  it('is what their groups grant, not the whole library', async () => {
    mem.hash('pvp:user_scope').set('s@x.com', JSON.stringify(['youth']));
    const access = await resolveAccess('s@x.com', { staff: true });
    expect(access).toEqual({ restricted: true, groupIds: ['youth'], collectionIds: ['sermons'], videoIds: ['v1', 'v3'] });
  });

  it('is nothing for a scope whose groups are gone', async () => {
    mem.hash('pvp:user_scope').set('s@x.com', JSON.stringify(['gone']));
    const access = await resolveAccess('s@x.com', { staff: true });
    expect(access.restricted).toBe(true);
    expect(access.videoIds).toEqual([]);
  });

  it('is nothing — never everything — when the scope cannot be read', async () => {
    scopeUnreadable();
    expect(await resolveAccess('s@x.com', { staff: true })).toEqual({
      restricted: true,
      groupIds: [],
      collectionIds: [],
      videoIds: [],
    });
  });

  it('is the whole library for unscoped staff and owners, as before', async () => {
    expect((await resolveAccess('s@x.com', { staff: true })).restricted).toBe(false);
    mem.hash('pvp:user_scope').set('admin@example.com', JSON.stringify(['youth']));
    expect((await resolveAccess('admin@example.com', { staff: true })).restricted).toBe(false);
  });
});

describe('holdersOf', () => {
  it('does not count a scoped holder for a portal-wide capability, but does for the rest', async () => {
    mem.hash('pvp:user_scope').set('s@x.com', JSON.stringify(['youth']));
    expect(await holdersOf(CAP.ROLES_MANAGE)).not.toContain('s@x.com');
    expect(await holdersOf(CAP.VIDEOS_MANAGE)).toContain('s@x.com');
  });
});
