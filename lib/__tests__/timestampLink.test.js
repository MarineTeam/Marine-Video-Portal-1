// Links that start a video at a moment.
//
// The failure that matters is quiet: a link that does not parse must NOT
// silently mean "start at the beginning", because it would override a saved
// resume position and drop the viewer at 0:00 with nothing explaining why.
// That is the difference between null and 0 throughout this module.
import { describe, expect, it } from 'vitest';
import { MAX_SECONDS, formatTimeParam, linkAtTime, parseTimeParam } from '../timestampLink';

describe('parseTimeParam: the shapes it accepts', () => {
  it('reads plain seconds, which is what this app generates', () => {
    expect(parseTimeParam('0')).toBe(0);
    expect(parseTimeParam('124')).toBe(124);
  });

  it('reads clock time, which is what people type', () => {
    expect(parseTimeParam('1:30')).toBe(90);
    expect(parseTimeParam('24:15')).toBe(24 * 60 + 15);
    expect(parseTimeParam('1:02:03')).toBe(3723);
  });

  it('reads minutes past 59 only when there is no hours field', () => {
    // 90:00 is a fair way to write an hour and a half; 1:90:00 is a typo.
    expect(parseTimeParam('90:00')).toBe(5400);
    expect(parseTimeParam('1:90:00')).toBeNull();
  });

  it('reads the unit form people paste from elsewhere', () => {
    expect(parseTimeParam('90s')).toBe(90);
    expect(parseTimeParam('2m')).toBe(120);
    expect(parseTimeParam('1h2m3s')).toBe(3723);
    expect(parseTimeParam('1H2M3S')).toBe(3723);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimeParam('  124  ')).toBe(124);
  });
});

describe('parseTimeParam: what it refuses', () => {
  it('returns NULL rather than 0 for junk', () => {
    // The whole point: null leaves a saved resume position alone, 0 would
    // silently send the viewer back to the start.
    for (const value of ['', '   ', 'abc', '1:2:3:4', '-5', '1:75', 's', 'm', '1x']) {
      expect(parseTimeParam(value)).toBeNull();
    }
  });

  it('returns null for a missing parameter', () => {
    expect(parseTimeParam(undefined)).toBeNull();
    expect(parseTimeParam(null)).toBeNull();
  });

  it('refuses a REPEATED parameter rather than picking one', () => {
    // ?t=1&t=2 — which did they mean? Neither.
    expect(parseTimeParam(['1', '2'])).toBeNull();
  });

  it('clamps an absurd value instead of seeking to the year 3000', () => {
    expect(parseTimeParam('999999999')).toBe(MAX_SECONDS);
  });

  it('floors a fractional value', () => {
    expect(parseTimeParam('12.9')).toBeNull(); // not a shape we accept
    expect(formatTimeParam(12.9)).toBe('12');
  });
});

describe('formatTimeParam', () => {
  it('writes plain seconds', () => {
    expect(formatTimeParam(0)).toBe('0');
    expect(formatTimeParam(124)).toBe('124');
  });

  it('writes nothing for a value that is not a time', () => {
    expect(formatTimeParam(-1)).toBe('');
    expect(formatTimeParam(NaN)).toBe('');
    expect(formatTimeParam('abc')).toBe('');
  });

  it('round-trips through the parser', () => {
    for (const seconds of [0, 1, 59, 60, 3599, 3600, 3723]) {
      expect(parseTimeParam(formatTimeParam(seconds))).toBe(seconds);
    }
  });
});

describe('linkAtTime', () => {
  it('adds the timestamp', () => {
    expect(linkAtTime('/watch/video/abc', 90)).toBe('/watch/video/abc?t=90');
  });

  it('REPLACES an existing t rather than appending a second one', () => {
    // Copying twice must not produce ?t=90&t=120, which parseTimeParam then
    // refuses — the link would land at the start.
    expect(linkAtTime('/watch/video/abc?t=90', 120)).toBe('/watch/video/abc?t=120');
  });

  it('keeps other query parameters', () => {
    expect(linkAtTime('/watch/video/abc?ref=email', 90)).toBe('/watch/video/abc?ref=email&t=90');
  });

  it('drops any fragment, which never survives a share anyway', () => {
    expect(linkAtTime('/watch/video/abc#transcript', 90)).toBe('/watch/video/abc?t=90');
  });

  it('removes t entirely for a time that is not shareable', () => {
    expect(linkAtTime('/watch/video/abc?t=90', -1)).toBe('/watch/video/abc');
  });

  it('works on an absolute URL', () => {
    expect(linkAtTime('https://example.com/watch/video/abc', 5)).toBe(
      'https://example.com/watch/video/abc?t=5'
    );
  });
});
