// lib/ratingScripts.js, run against a REAL redis-server.
//
// These scripts exist to make 'the total equals the votes' true, so the only
// honest test is to run them and count. Skipped locally when redis-server is
// not installed; never skipped under CI — see helpers/localRedis.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RECOUNT_SCRIPT, VOTE_SCRIPT } from '../ratingScripts';
import { countField, DOWN, UP, voteDelta } from '../ratings';
import { evalScript, shouldSkip, startRedis } from './helpers/localRedis';

const COUNTS = 't:rating_counts';
const votesOf = (email) => `t:ratings:${email}`;

let server;
let r;

async function vote(email, id, next) {
  return evalScript(r, VOTE_SCRIPT, [votesOf(email), COUNTS], [id, next || '']);
}

async function counts() {
  const flat = await r.call('HGETALL', COUNTS);
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
}

async function recount(emails) {
  return evalScript(r, RECOUNT_SCRIPT, [COUNTS, ...emails.map(votesOf)], []);
}

describe.skipIf(shouldSkip)('rating scripts on a real redis-server', () => {
  beforeAll(async () => {
    server = await startRedis();
    r = server.client;
  });
  afterAll(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    await r.call('FLUSHALL');
  });

  describe('VOTE_SCRIPT', () => {
    it('records a first vote and its counter together', async () => {
      expect(await vote('a', 'v1', 'up')).toBe(1);
      expect(await r.call('HGET', votesOf('a'), 'v1')).toBe('up');
      expect(await counts()).toEqual({ 'v1:up': 1 });
    });

    it('moves a changed vote from one counter to the other', async () => {
      await vote('a', 'v1', 'up');
      await vote('a', 'v1', 'down');
      expect(await counts()).toEqual({ 'v1:up': 0, 'v1:down': 1 });
    });

    it('treats a repeated vote as a no-op', async () => {
      await vote('a', 'v1', 'up');
      expect(await vote('a', 'v1', 'up')).toBe(0);
      expect(await counts()).toEqual({ 'v1:up': 1 });
    });

    it('clears a vote and gives its count back', async () => {
      await vote('a', 'v1', 'down');
      expect(await vote('a', 'v1', '')).toBe(1);
      expect(await r.call('HEXISTS', votesOf('a'), 'v1')).toBe(0);
      expect(await counts()).toEqual({ 'v1:down': 0 });
    });

    it('treats clearing a vote that does not exist as a no-op', async () => {
      expect(await vote('a', 'v1', '')).toBe(0);
      expect(await counts()).toEqual({});
    });

    it('reads an unknown stored value as no vote, as normalizeVote does', async () => {
      await r.call('HSET', votesOf('a'), 'v1', 'sideways');
      expect(await vote('a', 'v1', '')).toBe(0);
      expect(await r.call('HGET', votesOf('a'), 'v1')).toBe('sideways');
      expect(await vote('a', 'v1', 'up')).toBe(1);
      expect(await counts()).toEqual({ 'v1:up': 1 });
    });

    it('refuses to store anything but up or down', async () => {
      expect(await vote('a', 'v1', 'UP')).toBe(0);
      expect(await r.call('EXISTS', votesOf('a'))).toBe(0);
    });

    // No test here for the double-click race the old path lost (two requests
    // both reading 'no vote', both incrementing). Redis runs a script as one
    // command, so there is no interleaving to provoke from outside — and
    // three identical votes net to one either way, so a test that sends them
    // passes with or without the fix (a sabotage run showed exactly that).
    // The fix is structural: the previous vote is read INSIDE the script.

    // The script against the pure specification, every transition. voteDelta
    // is tested on its own in ratings.test.js, which runs in CI whether or not
    // redis-server is installed; this ties the Lua to it.
    const STATES = [null, UP, DOWN, 'sideways'];
    for (const before of STATES) {
      for (const after of STATES) {
        it(`moves the counters exactly as voteDelta says: ${before} -> ${after}`, async () => {
          if (before) await r.call('HSET', votesOf('a'), 'v1', before);
          await r.call('DEL', COUNTS);
          await vote('a', 'v1', after);
          const got = await counts();
          const want = voteDelta(before, after);
          for (const v of [UP, DOWN]) {
            expect(got[countField('v1', v)] || 0).toBe(want[v]);
          }
        });
      }
    }

    it('keeps viewers and videos apart', async () => {
      await vote('a', 'v1', 'up');
      await vote('b', 'v1', 'down');
      await vote('a', 'v2', 'down');
      expect(await counts()).toEqual({ 'v1:up': 1, 'v1:down': 1, 'v2:down': 1 });
    });

    it('handles a video id containing a colon', async () => {
      await vote('a', 'x:y', 'up');
      expect(await counts()).toEqual({ 'x:y:up': 1 });
    });
  });

  describe('RECOUNT_SCRIPT', () => {
    it('replaces drifted counters with the totals the votes add up to', async () => {
      await r.call('HSET', votesOf('a'), 'v1', 'up', 'v2', 'down');
      await r.call('HSET', votesOf('b'), 'v1', 'up');
      // Drift of every kind the old path could leave: short, negative, and a
      // counter for a video nobody has voted on any more.
      await r.call('HSET', COUNTS, 'v1:up', '1', 'v2:down', '-1', 'gone:up', '4');
      expect(await recount(['a', 'b'])).toEqual([3, 2]);
      expect(await counts()).toEqual({ 'v1:up': 2, 'v2:down': 1 });
    });

    it('ignores values that are not a vote', async () => {
      await r.call('HSET', votesOf('a'), 'v1', 'sideways', 'v2', 'up');
      expect(await recount(['a'])).toEqual([1, 1]);
      expect(await counts()).toEqual({ 'v2:up': 1 });
    });

    it('empties the counters when there are no votes at all', async () => {
      await r.call('HSET', COUNTS, 'v1:up', '3');
      expect(await recount([])).toEqual([0, 0]);
      expect(await r.call('EXISTS', COUNTS)).toBe(0);
    });

    it('tolerates a listed viewer whose hash has since gone', async () => {
      await r.call('HSET', votesOf('a'), 'v1', 'up');
      expect(await recount(['a', 'removed'])).toEqual([1, 1]);
    });

    it('writes more fields than one HSET slice holds', async () => {
      const args = [];
      for (let i = 0; i < 450; i++) args.push(`v${i}`, i % 2 ? 'up' : 'down');
      await r.call('HSET', votesOf('a'), ...args);
      expect(await recount(['a'])).toEqual([450, 450]);
      expect(await r.call('HLEN', COUNTS)).toBe(450);
    });

    it('agrees with the vote script afterwards', async () => {
      await vote('a', 'v1', 'up');
      await vote('b', 'v1', 'up');
      await r.call('HSET', COUNTS, 'v1:up', '7');
      await recount(['a', 'b']);
      await vote('b', 'v1', 'down');
      expect(await counts()).toEqual({ 'v1:up': 1, 'v1:down': 1 });
    });
  });
});
