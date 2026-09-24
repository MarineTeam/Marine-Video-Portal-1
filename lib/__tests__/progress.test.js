// lib/progress.js — the bounds on per-viewer playback progress.
import { describe, expect, it } from 'vitest';
import { MAX_PROGRESS_ENTRIES, MAX_TITLE_LENGTH, progressTitle, progressToEvict } from '../progress';

describe('progressTitle', () => {
  it('keeps text, bounded', () => {
    expect(progressTitle('Sunday')).toBe('Sunday');
    expect(progressTitle('x'.repeat(5000))).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('stores nothing that is not text', () => {
    for (const bad of [null, undefined, 5, ['a'], { a: 1 }]) expect(progressTitle(bad)).toBe('');
  });
});

describe('progressToEvict', () => {
  const at = (n) => Date.UTC(2026, 0, 1) + n * 60_000;

  it('is 1,000 videos', () => {
    expect(MAX_PROGRESS_ENTRIES).toBe(1000);
  });

  it('drops nothing while there is room for one more', () => {
    expect(progressToEvict({ a: { at: at(1) }, b: { at: at(2) } }, 3)).toEqual([]);
  });

  it('drops the least recently watched to make room for one more', () => {
    const all = { new: { at: at(9) }, old: { at: at(1) }, mid: { at: at(5) } };
    expect(progressToEvict(all, 3)).toEqual(['old']);
  });

  it('reads entries that arrive as JSON text', () => {
    const all = { new: JSON.stringify({ at: at(9) }), old: JSON.stringify({ at: at(1) }), mid: { at: at(5) } };
    expect(progressToEvict(all, 3)).toEqual(['old']);
  });

  it('brings an over-full hash back under the cap in one go', () => {
    const all = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id, i) => [id, { at: at(i) }]));
    expect(progressToEvict(all, 3)).toEqual(['a', 'b', 'c']);
  });

  it('counts an entry with no readable time as the oldest', () => {
    const all = { good: { at: at(1) }, text: 'not json', missing: {}, stringy: { at: 'yesterday' } };
    expect(progressToEvict(all, 2).sort()).toEqual(['missing', 'stringy', 'text']);
  });
});
