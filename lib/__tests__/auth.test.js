import { describe, it, expect } from 'vitest';
import { isAdmin } from '../auth';

// ADMIN_EMAILS is set to "admin@example.com, second@example.com" in vitest.config.js
describe('isAdmin', () => {
  it('recognizes a configured admin, case-insensitively', () => {
    expect(isAdmin('admin@example.com')).toBe(true);
    expect(isAdmin('ADMIN@Example.com')).toBe(true);
    expect(isAdmin('second@example.com')).toBe(true);
  });

  it('rejects non-admins', () => {
    expect(isAdmin('viewer@example.com')).toBe(false);
  });

  it('rejects falsy input', () => {
    expect(isAdmin('')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});
