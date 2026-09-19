// The AI-suggestion reader.
//
// What can go wrong here is quiet: a suggestion read at the wrong timestamp, a
// title dropped without a word, or — the one that matters most — a suggestion
// treated as a chapter. The pure reader is tested directly; the route's
// "writes nothing, spends nothing" half is checked STATICALLY, the way
// apiGates.test.js checks every admin route's gate, because mocking bunny and
// Redis to test a handler body produces tests that pass while production
// breaks (see the note at the top of that file).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_CHAPTERS, MAX_CHAPTER_LABEL, parseChapters } from '../videoMeta';
import { sameChapters, suggestedChapters } from '../aiChapters';

describe('suggestedChapters: bunny’s documented shape', () => {
  it('reads { title, start } in seconds', () => {
    expect(
      suggestedChapters({
        chapters: [
          { title: 'Worship', start: 0, end: 1110 },
          { title: 'Sermon', start: 1455, end: 3600 },
        ],
      }).chapters
    ).toEqual([
      { seconds: 0, label: 'Worship' },
      { seconds: 1455, label: 'Sermon' },
    ]);
  });

  it('falls back to moments when there are no chapters', () => {
    expect(
      suggestedChapters({ chapters: [], moments: [{ label: 'Baptism', timestamp: 300 }] }).chapters
    ).toEqual([{ seconds: 300, label: 'Baptism' }]);
  });

  it('prefers chapters over moments when both exist', () => {
    expect(
      suggestedChapters({
        chapters: [{ title: 'Sermon', start: 60 }],
        moments: [{ label: 'Baptism', timestamp: 300 }],
      }).chapters
    ).toEqual([{ seconds: 60, label: 'Sermon' }]);
  });

  it('returns nothing, and reports nothing, for a video with neither', () => {
    expect(suggestedChapters({})).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters(null)).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters({ chapters: 'not an array' })).toEqual({ chapters: [], ignored: [] });
  });

  it('produces a list the repo’s own formatter and parser round-trip', () => {
    // The whole accept flow is: suggestion -> textarea text -> parseChapters.
    // If the shape drifted from what parseChapters returns, the admin would
    // watch their accepted list come back different from what they accepted.
    const { chapters } = suggestedChapters({
      chapters: [
        { title: 'Worship', start: 0 },
        { title: 'Sermon', start: 3723 },
      ],
    });
    const text = chapters.map((c) => `${Math.floor(c.seconds / 60)}:00 ${c.label}`).join('\n');
    expect(parseChapters(text).ignored).toEqual([]);
  });
});

describe('suggestedChapters: what it refuses to guess', () => {
  it('does not turn a missing or blank start into 0:00', () => {
    // Number('') and Number(null) are both 0, which would plant a chapter at
    // the top of the video that reads like a real suggestion.
    const { chapters, ignored } = suggestedChapters({
      chapters: [
        { title: 'Blank', start: '' },
        { title: 'Null', start: null },
        { title: 'Junk', start: 'later' },
      ],
    });
    expect(chapters).toEqual([]);
    expect(ignored).toHaveLength(3);
    expect(ignored[0]).toContain('no usable start time');
  });

  it('reads a numeric string start, which is still unambiguous', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Sermon', start: '90' }] }).chapters).toEqual([
      { seconds: 90, label: 'Sermon' },
    ]);
  });

  it('skips a negative start', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Early', start: -5 }] }).chapters).toEqual([]);
  });

  it('skips an untitled suggestion and names the time it was at', () => {
    const { chapters, ignored } = suggestedChapters({ chapters: [{ title: '   ', start: 75 }] });
    expect(chapters).toEqual([]);
    expect(ignored).toEqual(['#1 at 1:15 — no title']);
  });

  it('floors a fractional start rather than storing it', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Sermon', start: 60.8 }] }).chapters).toEqual([
      { seconds: 60, label: 'Sermon' },
    ]);
  });
});

describe('suggestedChapters: the limits a typed list has', () => {
  it('truncates an over-long title instead of refusing it', () => {
    const { chapters } = suggestedChapters({
      chapters: [{ title: 'x'.repeat(MAX_CHAPTER_LABEL + 50), start: 1 }],
    });
    expect(chapters[0].label).toHaveLength(MAX_CHAPTER_LABEL);
  });

  it('caps at the chapter limit AFTER sorting, and reports what it dropped', () => {
    // Descending input: capping before the sort would keep the END of the
    // video and silently drop its beginning.
    const many = Array.from({ length: MAX_CHAPTERS + 3 }, (_, i) => ({
      title: `Part ${i}`,
      start: (MAX_CHAPTERS + 3 - i) * 10,
    }));
    const { chapters, ignored } = suggestedChapters({ chapters: many });
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(chapters[0].seconds).toBe(10);
    expect(ignored).toHaveLength(3);
    expect(ignored[0]).toContain(`over the ${MAX_CHAPTERS}-chapter limit`);
  });

  it('sorts by timestamp whatever order bunny returned', () => {
    const { chapters } = suggestedChapters({
      chapters: [
        { title: 'Sermon', start: 1455 },
        { title: 'Worship', start: 0 },
      ],
    });
    expect(chapters.map((c) => c.label)).toEqual(['Worship', 'Sermon']);
  });
});

describe('sameChapters', () => {
  const list = [
    { seconds: 0, label: 'Worship' },
    { seconds: 60, label: 'Sermon' },
  ];

  it('is true for identical lists and empty ones', () => {
    expect(sameChapters(list, list.map((c) => ({ ...c })))).toBe(true);
    expect(sameChapters([], [])).toBe(true);
    expect(sameChapters(null, undefined)).toBe(true);
  });

  it('is false when a time, a label or the length differs', () => {
    expect(
      sameChapters(list, [{ seconds: 0, label: 'Worship' }, { seconds: 61, label: 'Sermon' }])
    ).toBe(false);
    expect(
      sameChapters(list, [{ seconds: 0, label: 'worship' }, { seconds: 60, label: 'Sermon' }])
    ).toBe(false);
    expect(sameChapters(list, list.slice(0, 1))).toBe(false);
  });
});

// --- Static: a suggestion must never become a write, or a charge -----------

describe('the suggestions branch of /api/admin/transcribe', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'pages/api/admin/transcribe.js'),
    'utf8'
  );

  it('is handled BEFORE the limiter that guards the paid call', () => {
    // Order is the whole guarantee: a free read must not be able to reach
    // transcribeVideo, and must not be refused when the paid budget is spent.
    const branch = src.indexOf('body.suggestions === true');
    const limiter = src.indexOf('allowCostly(');
    expect(branch).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(limiter);
  });

  it('writes nothing — the function body has no store or audit call', () => {
    const body = src.slice(
      src.indexOf('async function suggestions('),
      src.indexOf('async function ingest(')
    );
    expect(body).toContain('getVideoById');
    expect(body).not.toContain('setTranscript');
    expect(body).not.toContain('logAudit');
    expect(body).not.toContain('transcribeVideo');
  });

  it('asks bunny to generate chapters only on a strict true', () => {
    expect(src).toContain('body.chapters === true');
  });
});

describe('lib/aiChapters.js stays pure', () => {
  it('imports only the pure metadata module', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/aiChapters.js'), 'utf8');
    const imports = src.match(/^import .*$/gm) || [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('./videoMeta');
  });
});
