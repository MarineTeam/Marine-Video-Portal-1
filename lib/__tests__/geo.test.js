import { describe, it, expect } from 'vitest';
import { isCountryAllowed, getCountry } from '../geo';

describe('isCountryAllowed', () => {
  it('always allows when the whitelist is disabled', () => {
    expect(isCountryAllowed('RU', { enabled: false, countries: ['US'] })).toBe(true);
  });

  it('always allows when the country is unknown (fails open)', () => {
    expect(isCountryAllowed(null, { enabled: true, countries: ['US'] })).toBe(true);
  });

  it('allows a listed country and blocks one that is not listed', () => {
    const whitelist = { enabled: true, countries: ['US', 'CA'] };
    expect(isCountryAllowed('US', whitelist)).toBe(true);
    expect(isCountryAllowed('RU', whitelist)).toBe(false);
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
