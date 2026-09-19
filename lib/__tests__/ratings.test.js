// Ratings, the pure half.
//
// The counters are maintained by DELTA rather than by counting rows, which
// makes voteDelta the one function whose arithmetic must be exactly right: a
// wrong delta is a total that drifts further from the truth on every click,
// silently, with nothing to compare it against. Every transition is pinned
// here, including the two that must do nothing.
import { describe, expect, it } from 'vitest';
import {
  DOWN,
  UP,
  countField,
  countsByVideo,
  countsFor,
  normalizeRatings,
  normalizeVote,
  ratingOf,
  summarize,
  voteDelta,
} from '../ratings';

describe('normalizeVote', () => {
  it('accepts the two votes, in any casing or padding', () => {
    expect(normalizeVote('up')).toBe(UP);
    expect(normalizeVote(' UP ')).toBe(UP);
    expect(normalizeVote('Down')).toBe(DOWN);
  });

  it('reads anything else as no rating', () => {
    // A value from a future third option must read as ABSENT rather than as
    // one of the two we know, or a stored "meh" would silently count as up.
    for (const value of ['', 'meh', '1', 1, true, null, undefined, {}, []]) {
      expect(normalizeVote(value)).toBeNull();
    }
  });
});

describe('normalizeRatings / ratingOf', () => {
  it('keeps only well-formed entries', () => {
    expect(
      normalizeRatings({ 'vid-1': 'up', 'vid-2': 'sideways', '': 'up', 'vid-3': 'DOWN' })
    ).toEqual({ 'vid-1': UP, 'vid-3': DOWN });
  });

  it('degrades a malformed record to no ratings', () => {
    expect(normalizeRatings(null)).toEqual({});
    expect(normalizeRatings('nonsense')).toEqual({});
    expect(normalizeRatings([])).toEqual({});
  });

  it("finds one video's rating, or null", () => {
    const raw = { 'vid-1': 'up' };
    expect(ratingOf(raw, 'vid-1')).toBe(UP);
    expect(ratingOf(raw, 'vid-2')).toBeNull();
    expect(ratingOf(raw, '')).toBeNull();
    expect(ratingOf(null, 'vid-1')).toBeNull();
  });
});

describe('voteDelta: every transition', () => {
  const nothing = { [UP]: 0, [DOWN]: 0 };

  it('first vote adds one', () => {
    expect(voteDelta(null, 'up')).toEqual({ [UP]: 1, [DOWN]: 0 });
    expect(voteDelta(null, 'down')).toEqual({ [UP]: 0, [DOWN]: 1 });
  });

  it('switching moves one across', () => {
    expect(voteDelta('up', 'down')).toEqual({ [UP]: -1, [DOWN]: 1 });
    expect(voteDelta('down', 'up')).toEqual({ [UP]: 1, [DOWN]: -1 });
  });

  it('clearing takes one away', () => {
    expect(voteDelta('up', null)).toEqual({ [UP]: -1, [DOWN]: 0 });
    expect(voteDelta('down', null)).toEqual({ [UP]: 0, [DOWN]: -1 });
  });

  it('re-sending the same vote does NOTHING', () => {
    // The route also short-circuits this case, but the arithmetic has to be
    // safe on its own: a double-click that counted twice would inflate a
    // total with no way to notice.
    expect(voteDelta('up', 'up')).toEqual(nothing);
    expect(voteDelta('down', 'down')).toEqual(nothing);
    expect(voteDelta(null, null)).toEqual(nothing);
  });

  it('treats an unreadable stored vote as no vote, not as a third state', () => {
    expect(voteDelta('sideways', 'up')).toEqual({ [UP]: 1, [DOWN]: 0 });
    expect(voteDelta('up', 'sideways')).toEqual({ [UP]: -1, [DOWN]: 0 });
  });
});

describe('countField', () => {
  it('builds the counter field name', () => {
    expect(countField('vid-1', 'up')).toBe('vid-1:up');
    expect(countField(' vid-1 ', 'DOWN')).toBe('vid-1:down');
  });

  it('refuses to build one from junk', () => {
    expect(countField('', 'up')).toBeNull();
    expect(countField('vid-1', 'sideways')).toBeNull();
  });
});

describe('countsByVideo', () => {
  it('reads the counters hash back per video', () => {
    expect(
      countsByVideo({ 'vid-1:up': 3, 'vid-1:down': 1, 'vid-2:up': '2' })
    ).toEqual({
      'vid-1': { [UP]: 3, [DOWN]: 1 },
      'vid-2': { [UP]: 2, [DOWN]: 0 },
    });
  });

  it('handles a video id containing a colon', () => {
    // Split on the LAST colon, not the first — an id with one in it would
    // otherwise be truncated and its votes attributed to a video that does
    // not exist.
    expect(countsByVideo({ 'a:b:up': 2 })).toEqual({ 'a:b': { [UP]: 2, [DOWN]: 0 } });
  });

  it('clamps a drifted negative counter to zero', () => {
    // A half-failed write can leave a counter below zero. "-1 up" on the
    // admin list would read like data loss; zero reads like nobody voted,
    // which is nearer the truth and is the documented behaviour.
    expect(countsByVideo({ 'vid-1:up': -2 })).toEqual({ 'vid-1': { [UP]: 0, [DOWN]: 0 } });
  });

  it('drops fields it cannot read', () => {
    expect(countsByVideo({ 'vid-1': 3, ':up': 1, 'vid-2:sideways': 4, 'vid-3:up': 'x' })).toEqual(
      {}
    );
    expect(countsByVideo(null)).toEqual({});
  });
});

describe('countsFor / summarize', () => {
  const byVideo = countsByVideo({ 'vid-1:up': 3, 'vid-1:down': 1 });

  it('returns zeroes for a video nobody rated', () => {
    expect(countsFor(byVideo, 'vid-9')).toEqual({ [UP]: 0, [DOWN]: 0 });
    expect(countsFor(null, 'vid-1')).toEqual({ [UP]: 0, [DOWN]: 0 });
  });

  it('summarizes a rated video', () => {
    expect(summarize(countsFor(byVideo, 'vid-1'))).toEqual({ up: 3, down: 1, total: 4 });
  });

  it('summarizes an unrated video as null, not as zeroes', () => {
    // The admin list shows nothing at all for an unrated video: "0 up, 0
    // down" reads like a bad score rather than like no score.
    expect(summarize(countsFor(byVideo, 'vid-9'))).toBeNull();
    expect(summarize(null)).toBeNull();
  });
});

// --- Static: a new per-viewer key family must join the sweep ---------------

describe('the ratings key family is swept', () => {
  it('appears in lib/maintenance.js VIEWER_KEY_PREFIXES', async () => {
    // Per-viewer data that nothing collects is known-weak-point #3, and it was
    // created exactly this way: a key family added without this line. The
    // sweep is the only thing that will ever remove a departed viewer's votes.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/maintenance.js'),
      'utf8'
    );
    const line = src.match(/const VIEWER_KEY_PREFIXES = \[([^\]]*)\]/);
    expect(line, 'VIEWER_KEY_PREFIXES not found').not.toBeNull();
    expect(line[1]).toContain("'ratings:'");
    expect(line[1]).toContain("'progress:'");
    expect(line[1]).toContain("'mylist:'");
  });
});
