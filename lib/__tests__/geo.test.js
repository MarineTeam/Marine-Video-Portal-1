import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isCountryAllowed,
  getCountry,
  isAdminGeoBypassed,
  getViewerCountries,
  getAdminCountries,
} from '../geo';

describe('isCountryAllowed', () => {
  it('always allows when the toggle is off', () => {
    expect(isCountryAllowed('RU', ['US'], false)).toBe(true);
  });

  it('always allows when the country is unknown (fails open)', () => {
    expect(isCountryAllowed(null, ['US'], true)).toBe(true);
  });

  it('always allows when the country list is empty (fails open)', () => {
    expect(isCountryAllowed('RU', [], true)).toBe(true);
  });

  it('allows a listed country and blocks one that is not listed', () => {
    expect(isCountryAllowed('US', ['US', 'CA'], true)).toBe(true);
    expect(isCountryAllowed('RU', ['US', 'CA'], true)).toBe(false);
  });
});

describe('getCountry', () => {
  it('reads and uppercases the Vercel geo header', () => {
    expect(getCountry({ headers: { 'x-vercel-ip-country': 'us' } })).toBe('US');
  });

  it('returns null when the header is absent', () => {
    expect(getCountry({ headers: {} })).toBe(null);
  });
});

describe('env-configured country lists', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('parses, uppercases, and dedupes GEO_WHITELIST', () => {
    process.env.GEO_WHITELIST = 'us, us, ca ; gb';
    expect(getViewerCountries()).toEqual(['US', 'CA', 'GB']);
  });

  it('parses ADMIN_GEO_WHITELIST separately from the viewer list', () => {
    process.env.GEO_WHITELIST = 'US';
    process.env.ADMIN_GEO_WHITELIST = 'DE';
    expect(getViewerCountries()).toEqual(['US']);
    expect(getAdminCountries()).toEqual(['DE']);
  });

  it('ignores malformed entries that are not 2-letter codes', () => {
    process.env.GEO_WHITELIST = 'USA, U, 12, US';
    expect(getViewerCountries()).toEqual(['US']);
  });

  it('is empty when unset', () => {
    delete process.env.GEO_WHITELIST;
    expect(getViewerCountries()).toEqual([]);
  });
});

describe('isAdminGeoBypassed', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('matches an email in ADMIN_GEO_BYPASS_EMAILS case-insensitively', () => {
    process.env.ADMIN_GEO_BYPASS_EMAILS = 'Admin@Example.com, other@example.com';
    expect(isAdminGeoBypassed('admin@example.com')).toBe(true);
    expect(isAdminGeoBypassed('nobody@example.com')).toBe(false);
  });

  it('is false when unset or given no email', () => {
    delete process.env.ADMIN_GEO_BYPASS_EMAILS;
    expect(isAdminGeoBypassed('admin@example.com')).toBe(false);
    expect(isAdminGeoBypassed(null)).toBe(false);
  });
});
