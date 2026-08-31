import { describe, it, expect } from 'vitest';
import {
  toTimestamp,
  parseEntry,
  scheduleState,
  isVisibleNow,
  filterScheduled,
  isImpossibleWindow,
  STATE_LIVE,
  STATE_SCHEDULED,
  STATE_EXPIRED,
  STATE_NONE,
} from '../schedule';

const T = Date.UTC(2026, 5, 15, 12, 0, 0); // fixed "now" for every case below
const HOUR = 3600 * 1000;

describe('toTimestamp', () => {
  it('passes through a ms epoch number', () => {
    expect(toTimestamp(T)).toBe(T);
  });

  it('parses a numeric string and an ISO string', () => {
    expect(toTimestamp(String(T))).toBe(T);
    expect(toTimestamp('2026-06-15T12:00:00.000Z')).toBe(T);
  });

  // What <input type="datetime-local"> submits.
  it('parses a datetime-local value', () => {
    expect(toTimestamp('2026-06-15T12:00')).toBe(Date.parse('2026-06-15T12:00'));
  });

  // A bad value must degrade to "no bound", never to NaN — NaN comparisons are
  // all false, which would silently make a video visible or invisible forever.
  it('returns null for empty and unparseable input', () => {
    for (const bad of ['', '   ', null, undefined, 'not a date', {}, NaN]) {
      expect(toTimestamp(bad)).toBeNull();
    }
  });
});

describe('scheduleState', () => {
  it('is "none" when nothing is scheduled', () => {
    expect(scheduleState(null, T)).toBe(STATE_NONE);
    expect(scheduleState({ publishAt: null, expiresAt: null }, T)).toBe(STATE_NONE);
  });

  it('is "scheduled" before the publish time', () => {
    expect(scheduleState({ publishAt: T + HOUR, expiresAt: null }, T)).toBe(STATE_SCHEDULED);
  });

  it('is "live" once published with no expiry', () => {
    expect(scheduleState({ publishAt: T - HOUR, expiresAt: null }, T)).toBe(STATE_LIVE);
  });

  it('is "expired" at and after the expiry time', () => {
    expect(scheduleState({ publishAt: null, expiresAt: T }, T)).toBe(STATE_EXPIRED);
    expect(scheduleState({ publishAt: null, expiresAt: T - 1 }, T)).toBe(STATE_EXPIRED);
  });

  it('is "live" inside a two-sided window', () => {
    expect(scheduleState({ publishAt: T - HOUR, expiresAt: T + HOUR }, T)).toBe(STATE_LIVE);
  });

  it('publishes exactly at the boundary', () => {
    expect(scheduleState({ publishAt: T, expiresAt: null }, T)).toBe(STATE_LIVE);
  });
});

describe('isVisibleNow', () => {
  // The additive rule: no schedule means unchanged behaviour.
  it('shows an unscheduled video', () => {
    expect(isVisibleNow(null, T)).toBe(true);
    expect(isVisibleNow(undefined, T)).toBe(true);
  });

  it('hides before publish and after expiry, shows in between', () => {
    expect(isVisibleNow({ publishAt: T + HOUR, expiresAt: null }, T)).toBe(false);
    expect(isVisibleNow({ publishAt: null, expiresAt: T - HOUR }, T)).toBe(false);
    expect(isVisibleNow({ publishAt: T - HOUR, expiresAt: T + HOUR }, T)).toBe(true);
  });
});

describe('filterScheduled', () => {
  const videos = [
    { guid: 'a', title: 'Unscheduled' },
    { guid: 'b', title: 'Future' },
    { guid: 'c', title: 'Expired' },
    { guid: 'd', title: 'In window' },
  ];
  const schedules = {
    b: { publishAt: T + HOUR, expiresAt: null },
    c: { publishAt: null, expiresAt: T - HOUR },
    d: { publishAt: T - HOUR, expiresAt: T + HOUR },
  };

  it('keeps unscheduled and in-window videos only', () => {
    expect(filterScheduled(schedules, videos, T).map((v) => v.guid)).toEqual(['a', 'd']);
  });

  it('is a pass-through when nothing is scheduled', () => {
    expect(filterScheduled({}, videos, T)).toHaveLength(4);
    expect(filterScheduled(null, videos, T)).toHaveLength(4);
  });
});

describe('parseEntry', () => {
  it('reads both the stored JSON string and an already-parsed object', () => {
    const entry = { publishAt: T, expiresAt: T + HOUR };
    expect(parseEntry(JSON.stringify(entry))).toEqual(entry);
    expect(parseEntry(entry)).toEqual(entry);
  });

  it('treats an entry with no usable bound as no entry', () => {
    expect(parseEntry('{"publishAt":null,"expiresAt":null}')).toBeNull();
    expect(parseEntry('{"publishAt":"garbage"}')).toBeNull();
  });

  it('survives malformed JSON', () => {
    expect(parseEntry('{not json')).toBeNull();
    expect(parseEntry(null)).toBeNull();
  });
});

describe('isImpossibleWindow', () => {
  // Dates entered the wrong way round would hide the video forever with no
  // explanation, so this is rejected at the write instead of stored.
  it('flags an expiry at or before the publish time', () => {
    expect(isImpossibleWindow(T, T - HOUR)).toBe(true);
    expect(isImpossibleWindow(T, T)).toBe(true);
  });

  it('allows a normal window and any one-sided bound', () => {
    expect(isImpossibleWindow(T, T + HOUR)).toBe(false);
    expect(isImpossibleWindow(T, null)).toBe(false);
    expect(isImpossibleWindow(null, T)).toBe(false);
    expect(isImpossibleWindow(null, null)).toBe(false);
  });
});
