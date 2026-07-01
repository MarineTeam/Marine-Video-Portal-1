import { describe, it, expect } from 'vitest';
import { applyOrder } from '../order';

const vid = (guid, dateUploaded) => ({ guid, dateUploaded, title: guid });

describe('applyOrder', () => {
  it('places saved-order videos first, in the saved order', () => {
    const videos = [vid('a', '2024-01-01'), vid('b', '2024-01-02'), vid('c', '2024-01-03')];
    // b is not in the order, so it floats to the top; c then a follow.
    expect(applyOrder(videos, ['c', 'a']).map((v) => v.guid)).toEqual(['b', 'c', 'a']);
  });

  it('puts unordered (new) videos on top, newest first', () => {
    const videos = [vid('old', '2024-01-01'), vid('new', '2024-03-01'), vid('mid', '2024-02-01')];
    expect(applyOrder(videos, []).map((v) => v.guid)).toEqual(['new', 'mid', 'old']);
  });

  it('ignores ids in the saved order that no longer exist', () => {
    const videos = [vid('a', '2024-01-01')];
    expect(applyOrder(videos, ['ghost', 'a']).map((v) => v.guid)).toEqual(['a']);
  });

  it('returns everything exactly once', () => {
    const videos = [vid('a', '2024-01-01'), vid('b', '2024-01-02')];
    const out = applyOrder(videos, ['b']);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((v) => v.guid))).toEqual(new Set(['a', 'b']));
  });
});
