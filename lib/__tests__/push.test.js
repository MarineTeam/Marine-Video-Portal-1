import { describe, it, expect } from 'vitest';
import { isFreshReady } from '../push';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

describe('isFreshReady', () => {
  it('is true for a finished (status 4) video uploaded within 24h', () => {
    expect(isFreshReady({ guid: 'g', status: 4, dateUploaded: hoursAgo(1) }, NOW)).toBe(true);
    expect(isFreshReady({ guid: 'g', status: 4, dateUploaded: hoursAgo(23) }, NOW)).toBe(true);
  });

  it('is false for a video still encoding (status < 4) or failed (status 5/6)', () => {
    expect(isFreshReady({ guid: 'g', status: 3, dateUploaded: hoursAgo(1) }, NOW)).toBe(false);
    expect(isFreshReady({ guid: 'g', status: 5, dateUploaded: hoursAgo(1) }, NOW)).toBe(false);
  });

  it('is false for an old ready video (guards against back-blasting the library)', () => {
    expect(isFreshReady({ guid: 'g', status: 4, dateUploaded: hoursAgo(25) }, NOW)).toBe(false);
  });

  it('is false when guid or upload date is missing or unparseable', () => {
    expect(isFreshReady({ status: 4, dateUploaded: hoursAgo(1) }, NOW)).toBe(false);
    expect(isFreshReady({ guid: 'g', status: 4 }, NOW)).toBe(false);
    expect(isFreshReady({ guid: 'g', status: 4, dateUploaded: 'not-a-date' }, NOW)).toBe(false);
    expect(isFreshReady(null, NOW)).toBe(false);
  });
});
