// lib/capabilities.js — the catalog and the pure rules of custom roles.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_CAPABILITIES,
  CAP,
  CAPABILITY_INFO,
  LEGACY_MANAGER_CAPABILITIES,
  assignmentNeedsViewerManage,
  canDelegate,
  effectiveCapabilities,
  emailsWithCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  undelegatableCapabilities,
} from '../capabilities';

describe('the catalog', () => {
  it('labels every capability, once', () => {
    expect(CAPABILITY_INFO.map((c) => c.cap).sort()).toEqual([...ALL_CAPABILITIES]);
  });

  // Property 1: every capability names an enforcement point. One that no
  // route checks would read as though it granted something.
  it('names only capabilities some route actually enforces', () => {
    const files = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(process.cwd(), 'pages'));
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const cap of ALL_CAPABILITIES) {
      expect(src.includes(`'${cap}'`), `${cap} is enforced nowhere`).toBe(true);
    }
  });

  it('keeps the old Manager set: everything but settings and roles', () => {
    expect(LEGACY_MANAGER_CAPABILITIES).not.toContain(CAP.SETTINGS_MANAGE);
    expect(LEGACY_MANAGER_CAPABILITIES).not.toContain(CAP.ROLES_MANAGE);
    expect(LEGACY_MANAGER_CAPABILITIES).toHaveLength(ALL_CAPABILITIES.length - 2);
  });
});

describe('normalizeCapabilities', () => {
  it('drops unknown names, dedupes and sorts', () => {
    expect(normalizeCapabilities(['videos:manage', 'nope', 'audit:read', 'videos:manage'])).toEqual([
      'audit:read',
      'videos:manage',
    ]);
  });

  it('treats junk as nothing', () => {
    expect(normalizeCapabilities('videos:manage')).toEqual([]);
    expect(normalizeCapabilities(null)).toEqual([]);
  });
});

describe('effectiveCapabilities', () => {
  const rolesById = {
    a: { capabilities: ['videos:manage'] },
    b: { capabilities: ['audit:read', 'videos:manage', 'made:up'] },
  };

  it('gives an owner everything, whatever is stored', () => {
    expect(effectiveCapabilities({ owner: true, roleIds: [], rolesById: {} })).toEqual([...ALL_CAPABILITIES]);
  });

  it('is the union of the roles held, unknown names ignored', () => {
    expect(effectiveCapabilities({ roleIds: ['a', 'b'], rolesById })).toEqual(['audit:read', 'videos:manage']);
  });

  it('counts a deleted role as nothing', () => {
    expect(effectiveCapabilities({ roleIds: ['gone'], rolesById })).toEqual([]);
  });
});

describe('no escalation', () => {
  it('lets an actor hand out a subset of what they hold', () => {
    expect(canDelegate(['videos:manage', 'audit:read'], ['audit:read'])).toBe(true);
  });

  it('refuses anything they do not hold, and names it', () => {
    expect(canDelegate(['videos:manage'], ['videos:manage', 'roles:manage'])).toBe(false);
    expect(undelegatableCapabilities(['videos:manage'], ['roles:manage', 'videos:manage'])).toEqual([
      'roles:manage',
    ]);
  });

  it('ignores unknown names rather than refusing on them', () => {
    expect(canDelegate([], ['made:up'])).toBe(true);
  });
});

describe('assignmentNeedsViewerManage', () => {
  const base = { owner: false, actorCaps: ['roles:manage', 'audit:read'], grantedCaps: ['audit:read'] };

  it('requires viewers:manage to give a first foothold to someone not approved', () => {
    expect(assignmentNeedsViewerManage({ ...base, targetApproved: false })).toBe(true);
  });

  it('does not for someone already approved, an owner, a viewers:manage holder, or a removal', () => {
    expect(assignmentNeedsViewerManage({ ...base, targetApproved: true })).toBe(false);
    expect(assignmentNeedsViewerManage({ ...base, owner: true })).toBe(false);
    expect(assignmentNeedsViewerManage({ ...base, actorCaps: [...base.actorCaps, 'viewers:manage'] })).toBe(false);
    expect(assignmentNeedsViewerManage({ ...base, grantedCaps: [] })).toBe(false);
  });
});

describe('emailsWithCapability', () => {
  it('is the owners plus everyone whose roles give it', () => {
    const out = emailsWithCapability({
      owners: ['o@x.com'],
      assignments: { 'a@x.com': ['r1'], 'b@x.com': ['r2'] },
      rolesById: { r1: { capabilities: ['viewers:manage'] }, r2: { capabilities: ['audit:read'] } },
      cap: 'viewers:manage',
    });
    expect(out).toEqual(['a@x.com', 'o@x.com']);
  });
});

describe('role names and ids', () => {
  it('trims, collapses and bounds a name; empty is no name', () => {
    expect(normalizeRoleName('  Media   team ')).toBe('Media team');
    expect(normalizeRoleName('x'.repeat(80))).toHaveLength(60);
    expect(normalizeRoleName('   ')).toBeNull();
  });

  it('derives a valid id that never looks like an email', () => {
    const id = roleIdFromName('Media Team!', () => 'abc123');
    expect(id).toBe('media-team-abc123');
    expect(isValidRoleId(id)).toBe(true);
    expect(isValidRoleId('a@b.com')).toBe(false);
    expect(isValidRoleId('')).toBe(false);
    expect(isValidRoleId(roleIdFromName('!!!', () => 'z'))).toBe(true);
  });
});
