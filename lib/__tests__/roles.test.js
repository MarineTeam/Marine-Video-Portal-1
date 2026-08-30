import { describe, it, expect } from 'vitest';
import {
  roleHasCapability,
  capabilitiesForRole,
  CAPABILITIES,
  ROLE_ADMIN,
  ROLE_MANAGER,
  ROLE_VIEWER,
  ROLE_NONE,
} from '../roles';

// The capability map is the whole access model for pages/api/admin/*, so it
// gets pinned here: a route names a capability, and this decides who holds it.
describe('roleHasCapability', () => {
  it('gives admins every capability', () => {
    for (const cap of Object.keys(CAPABILITIES)) {
      expect(roleHasCapability(ROLE_ADMIN, cap)).toBe(true);
    }
  });

  it('lets managers curate the library', () => {
    for (const cap of ['videos:manage', 'shares:manage', 'viewers:manage', 'groups:manage']) {
      expect(roleHasCapability(ROLE_MANAGER, cap)).toBe(true);
    }
  });

  it('withholds settings and role management from managers', () => {
    expect(roleHasCapability(ROLE_MANAGER, 'settings:manage')).toBe(false);
    expect(roleHasCapability(ROLE_MANAGER, 'roles:manage')).toBe(false);
  });

  it('gives viewers and signed-out callers nothing', () => {
    for (const cap of Object.keys(CAPABILITIES)) {
      expect(roleHasCapability(ROLE_VIEWER, cap)).toBe(false);
      expect(roleHasCapability(ROLE_NONE, cap)).toBe(false);
    }
  });

  // A typo'd capability name in a route must close the route, not open it.
  it('fails closed on an unknown capability', () => {
    expect(roleHasCapability(ROLE_ADMIN, 'settings:manged')).toBe(false);
    expect(roleHasCapability(ROLE_ADMIN, '')).toBe(false);
    expect(roleHasCapability(ROLE_ADMIN, undefined)).toBe(false);
  });
});

describe('capabilitiesForRole', () => {
  it("is a strict superset for admins over managers", () => {
    const admin = capabilitiesForRole(ROLE_ADMIN);
    const manager = capabilitiesForRole(ROLE_MANAGER);
    expect(manager.every((c) => admin.includes(c))).toBe(true);
    expect(admin.length).toBeGreaterThan(manager.length);
  });

  it('returns nothing for a plain viewer', () => {
    expect(capabilitiesForRole(ROLE_VIEWER)).toEqual([]);
  });
});
