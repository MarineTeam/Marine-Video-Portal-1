// Which queued transcriptions get checked, and when we stop checking.
//
// Everything that can go wrong with collecting automatically is a scheduling
// decision: checking before bunny could possibly have finished, checking
// forever, or checking everything at once on one page load. All three are
// this module's job, so all three are pinned here.
import { describe, expect, it } from 'vitest';
import {
  MAX_COLLECT_PER_REQUEST,
  PENDING_GRACE_MS,
  PENDING_MAX_AGE_MS,
  planCollection,
} from '../transcribeQueue';

const NOW = 1_000_000_000_000;
const agedBy = (ms) => NOW - ms;

describe('planCollection', () => {
  it('skips a job queued moments ago', () => {
    // Transcription cannot be finished yet, and checking would spend two
    // bunny calls on the very request that queued it.
    const plan = planCollection({ a: agedBy(PENDING_GRACE_MS - 1) }, { now: NOW });
    expect(plan.collect).toEqual([]);
    expect(plan.expired).toEqual([]);
  });

  it('collects a job once it is past the grace period', () => {
    const plan = planCollection({ a: agedBy(PENDING_GRACE_MS + 1) }, { now: NOW });
    expect(plan.collect).toEqual(['a']);
  });

  it('gives up on a job past the deadline instead of retrying forever', () => {
    // A day means something retrying will not fix — the video was deleted,
    // the job failed, the key changed. The marker is dropped so it stops
    // costing two bunny calls on every admin page load.
    const plan = planCollection({ a: agedBy(PENDING_MAX_AGE_MS + 1) }, { now: NOW });
    expect(plan.expired).toEqual(['a']);
    expect(plan.collect).toEqual([]);
  });

  it('treats an unreadable timestamp as ancient, not as new', () => {
    // The opposite reading would retry a corrupt marker forever.
    const plan = planCollection({ a: 'not a date', b: null }, { now: NOW });
    expect(plan.expired.sort()).toEqual(['a', 'b']);
    expect(plan.collect).toEqual([]);
  });

  it('takes the OLDEST first', () => {
    // Likeliest to be ready, and the one an admin has waited longest for.
    const plan = planCollection(
      {
        young: agedBy(2 * PENDING_GRACE_MS),
        old: agedBy(60 * 60 * 1000),
        middle: agedBy(10 * 60 * 1000),
      },
      { now: NOW }
    );
    expect(plan.collect).toEqual(['old', 'middle', 'young']);
  });

  it('caps how many one request will attempt', () => {
    const pending = {};
    for (let i = 0; i < MAX_COLLECT_PER_REQUEST + 4; i += 1) {
      pending[`v${i}`] = agedBy((i + 2) * PENDING_GRACE_MS);
    }
    const plan = planCollection(pending, { now: NOW });
    expect(plan.collect).toHaveLength(MAX_COLLECT_PER_REQUEST);
  });

  it('honours a smaller explicit limit', () => {
    const plan = planCollection(
      { a: agedBy(60_000_0), b: agedBy(60_000_1) },
      { now: NOW, limit: 1 }
    );
    expect(plan.collect).toHaveLength(1);
  });

  it('reports both lists at once', () => {
    const plan = planCollection(
      { fresh: agedBy(10 * PENDING_GRACE_MS), stale: agedBy(PENDING_MAX_AGE_MS + 5) },
      { now: NOW }
    );
    expect(plan.collect).toEqual(['fresh']);
    expect(plan.expired).toEqual(['stale']);
  });

  it('survives junk input', () => {
    expect(planCollection(null)).toEqual({ collect: [], expired: [] });
    expect(planCollection('nope')).toEqual({ collect: [], expired: [] });
    expect(planCollection({ '  ': agedBy(60_000_0) }).collect).toEqual([]);
  });
});
