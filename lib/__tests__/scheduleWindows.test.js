import { describe, it, expect, beforeEach, vi } from 'vitest';

// Repeating (weekly) windows and per-group windows (lib/schedule.js).
//
// Every instant below is written in UTC with the local time it corresponds
// to in the rule's zone beside it, because the whole point of the time zone
// is that the two differ — and differ by a different amount across a
// daylight-saving change. (2026-09-20 and 2026-11-01 are Sundays.)

const store = vi.hoisted(() => ({ hash: {}, failHgetall: false }));
vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    hgetall: async () => {
      if (store.failHgetall) throw new Error('redis down');
      return { ...store.hash };
    },
    // Upstash hands back JSON-looking strings already parsed; mirror that.
    hget: async (_key, field) => (store.hash[field] ? JSON.parse(store.hash[field]) : null),
    hset: async (_key, obj) => Object.assign(store.hash, obj),
    hdel: async (_key, field) => {
      delete store.hash[field];
      return 1;
    },
  },
}));

const {
  filterScheduled,
  getSchedule,
  inRepeatSlot,
  isValidTimeZone,
  isVisibleFor,
  isVisibleNow,
  MAX_GROUP_WINDOWS,
  pruneGroupFromSchedules,
  scheduleState,
  setSchedule,
  validateGroupWindows,
  validateRepeat,
} = await import('../schedule');

const at = (iso) => Date.parse(iso);
const sundayMorning = { days: [0], start: '09:00', end: '13:00', timeZone: 'Europe/London' };
const G1 = '6f1c1c9e-6d7a-4c1a-9a57-000000000001';
const G2 = '6f1c1c9e-6d7a-4c1a-9a57-000000000002';

beforeEach(() => {
  store.hash = {};
  store.failHgetall = false;
});

describe('inRepeatSlot', () => {
  it('is inside the slot on the right day at the right local time (summer, UTC+1)', () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T09:00:00Z'))).toBe(true); // Sun 10:00 London
  });

  it('is outside before the start and AT the end (end is exclusive)', () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T07:59:00Z'))).toBe(false); // 08:59
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T12:00:00Z'))).toBe(false); // 13:00
  });

  it('is outside on another day at the same time', () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-21T09:00:00Z'))).toBe(false); // Mon 10:00
  });

  it("uses the RULE's time zone, not UTC, and follows daylight saving", () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T08:30:00Z'))).toBe(true); // 09:30 BST
    expect(inRepeatSlot(sundayMorning, at('2026-11-01T08:30:00Z'))).toBe(false); // 08:30 GMT
    expect(inRepeatSlot(sundayMorning, at('2026-11-01T09:30:00Z'))).toBe(true); // 09:30 GMT
  });

  it('works in a zone far from UTC, where the local DAY differs', () => {
    const la = { ...sundayMorning, timeZone: 'America/Los_Angeles' };
    expect(inRepeatSlot(la, at('2026-09-20T17:00:00Z'))).toBe(true); // Sun 10:00 PDT
    expect(inRepeatSlot(la, at('2026-09-21T02:00:00Z'))).toBe(false); // Sun 19:00 PDT
  });

  it('runs a slot past midnight into the next day, and only that day', () => {
    const lateSaturday = { days: [6], start: '22:00', end: '02:00', timeZone: 'UTC' };
    expect(inRepeatSlot(lateSaturday, at('2026-09-19T23:00:00Z'))).toBe(true); // Sat 23:00
    expect(inRepeatSlot(lateSaturday, at('2026-09-20T01:30:00Z'))).toBe(true); // Sun 01:30
    expect(inRepeatSlot(lateSaturday, at('2026-09-20T02:00:00Z'))).toBe(false); // Sun 02:00
    expect(inRepeatSlot(lateSaturday, at('2026-09-19T01:00:00Z'))).toBe(false); // Sat 01:00
  });

  it('treats a malformed stored rule as NO rule rather than taking the video down', () => {
    expect(inRepeatSlot({ days: [0], start: '9am', end: '13:00', timeZone: 'UTC' })).toBe(true);
    expect(inRepeatSlot({ days: [0], start: '09:00', end: '13:00', timeZone: 'Mars/Olympus' })).toBe(true);
  });
});

describe('repeat narrows the DEFAULT window', () => {
  const entry = { publishAt: at('2026-09-01T00:00:00Z'), expiresAt: null, repeat: sundayMorning };

  it('is visible inside both the dates and a slot, and not outside the slot', () => {
    expect(isVisibleNow(entry, at('2026-09-20T09:00:00Z'))).toBe(true);
    expect(isVisibleNow(entry, at('2026-09-21T09:00:00Z'))).toBe(false);
  });

  it('is not visible inside a slot but before the publish time', () => {
    expect(isVisibleNow(entry, at('2026-08-30T09:00:00Z'))).toBe(false);
  });

  it('narrows an entry that has no dates at all', () => {
    const onlyRule = { publishAt: null, expiresAt: null, repeat: sundayMorning };
    expect(isVisibleNow(onlyRule, at('2026-09-21T09:00:00Z'))).toBe(false);
  });

  it("does NOT bind a group's own window — leaders can preview outside service hours", () => {
    const withGroup = { ...entry, groups: { [G1]: { publishAt: at('2026-09-01T00:00:00Z'), expiresAt: null } } };
    const mondayMorning = at('2026-09-21T09:00:00Z');
    expect(isVisibleFor(withGroup, [G1], mondayMorning)).toBe(true);
    expect(isVisibleFor(withGroup, [G2], mondayMorning)).toBe(false);
  });

  it('describes the between-slots state for the admin chip', () => {
    expect(scheduleState(entry, at('2026-09-20T09:00:00Z'))).toBe('live');
    expect(scheduleState(entry, at('2026-09-21T09:00:00Z'))).toBe('off-slot');
    expect(scheduleState(entry, at('2026-08-30T09:00:00Z'))).toBe('scheduled');
  });
});

describe('validateRepeat', () => {
  it('accepts a sensible rule, and nothing at all', () => {
    expect(validateRepeat(sundayMorning)).toBeNull();
    expect(validateRepeat(null)).toBeNull();
  });

  it.each([
    [{ ...sundayMorning, days: [] }, /at least one day/],
    [{ ...sundayMorning, days: [7] }, /at least one day/],
    [{ ...sundayMorning, start: '9:00' }, /HH:MM/],
    [{ ...sundayMorning, end: '24:00' }, /HH:MM/],
    [{ ...sundayMorning, end: '09:00' }, /same time/],
    [{ ...sundayMorning, timeZone: 'Nowhere/Special' }, /time zone/],
    [[1, 2], /not valid/],
  ])('refuses %j', (rule, message) => {
    expect(validateRepeat(rule)).toMatch(message);
  });

  it('knows a real time zone from a made-up one', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Nowhere/Special')).toBe(false);
  });
});

describe('per-group windows are ADDITIVE only', () => {
  const NOW = at('2026-09-15T12:00:00Z');
  const entry = {
    publishAt: at('2026-10-01T00:00:00Z'),
    expiresAt: null,
    groups: { [G1]: { publishAt: at('2026-09-10T00:00:00Z'), expiresAt: null } },
  };

  it("lets a member watch in their group's window before everyone else", () => {
    expect(isVisibleFor(entry, [G1], NOW)).toBe(true);
    expect(isVisibleFor(entry, [G2], NOW)).toBe(false);
    expect(isVisibleFor(entry, [], NOW)).toBe(false);
  });

  it('falls back to the default window when the groups are not supplied — the safe direction', () => {
    expect(isVisibleFor(entry, undefined, NOW)).toBe(false);
  });

  it('can never HIDE a video from a group the default window shows it to', () => {
    const hold = { publishAt: null, expiresAt: null, groups: { [G1]: { publishAt: at('2099-01-01T00:00:00Z'), expiresAt: null } } };
    expect(isVisibleFor(hold, [G1], NOW)).toBe(true);
  });

  it('does not read inherited properties as group windows', () => {
    expect(isVisibleFor(entry, ['constructor', '__proto__', 'toString'], NOW)).toBe(false);
  });

  it("filters a list by the viewer's groups", () => {
    const videos = [{ guid: 'a' }, { guid: 'b' }];
    expect(filterScheduled({ a: entry }, videos, NOW).map((v) => v.guid)).toEqual(['b']);
    expect(filterScheduled({ a: entry }, videos, NOW, [G1]).map((v) => v.guid)).toEqual(['a', 'b']);
  });
});

describe('validateGroupWindows', () => {
  it('accepts windows for groups that exist, and drops empty ones', () => {
    const r = validateGroupWindows(
      { [G1]: { publishAt: '2026-09-10T00:00:00Z', expiresAt: '' }, [G2]: { publishAt: '', expiresAt: '' } },
      [G1, G2]
    );
    expect(r).toEqual({ groups: { [G1]: { publishAt: at('2026-09-10T00:00:00Z'), expiresAt: null } } });
  });

  it('refuses a window for a group that does not exist', () => {
    expect(validateGroupWindows({ [G2]: { publishAt: '2026-09-10T00:00:00Z' } }, [G1]).error).toMatch(/no longer exists/);
  });

  it('refuses an impossible group window, too many, and a non-object', () => {
    expect(
      validateGroupWindows({ [G1]: { publishAt: '2026-09-10T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' } }, [G1]).error
    ).toMatch(/after its publish/);
    const many = Object.fromEntries(Array.from({ length: MAX_GROUP_WINDOWS + 1 }, (_, i) => [`g-${i}`, {}]));
    expect(validateGroupWindows(many, Object.keys(many)).error).toMatch(/At most/);
    expect(validateGroupWindows([], [G1]).error).toMatch(/object/);
  });
});

describe('storage', () => {
  it('round-trips a rule and group windows, and keeps an entry that has ONLY a rule', async () => {
    await setSchedule('vid-1', { publishAt: '', expiresAt: '', repeat: sundayMorning });
    expect(await getSchedule('vid-1')).toEqual({ publishAt: null, expiresAt: null, repeat: sundayMorning });
    const groups = { [G1]: { publishAt: at('2026-09-10T00:00:00Z'), expiresAt: null } };
    await setSchedule('vid-2', { publishAt: '', expiresAt: '', groups });
    expect(await getSchedule('vid-2')).toEqual({ publishAt: null, expiresAt: null, groups });
  });

  it('deletes the entry when everything is cleared', async () => {
    await setSchedule('vid-1', { publishAt: '', expiresAt: '', repeat: sundayMorning });
    await setSchedule('vid-1', { publishAt: '', expiresAt: '' });
    expect(store.hash).toEqual({});
  });

  it("prunes a deleted group's window and keeps the rest of the entry", async () => {
    await setSchedule('vid-1', {
      publishAt: at('2026-10-01T00:00:00Z'),
      expiresAt: null,
      repeat: sundayMorning,
      groups: { [G1]: { publishAt: at('2026-09-10T00:00:00Z') }, [G2]: { publishAt: at('2026-09-11T00:00:00Z') } },
    });
    await setSchedule('vid-2', { publishAt: '', expiresAt: '', groups: { [G1]: { publishAt: at('2026-09-10T00:00:00Z') } } });
    expect(await pruneGroupFromSchedules(G1)).toBe(2);
    expect(await getSchedule('vid-1')).toEqual({
      publishAt: at('2026-10-01T00:00:00Z'),
      expiresAt: null,
      repeat: sundayMorning,
      groups: { [G2]: { publishAt: at('2026-09-11T00:00:00Z'), expiresAt: null } },
    });
    expect(store.hash['vid-2']).toBeUndefined();
  });

  it('lets a failed read reach the caller instead of silently pruning nothing', async () => {
    store.failHgetall = true;
    await expect(pruneGroupFromSchedules(G1)).rejects.toThrow('redis down');
  });
});
