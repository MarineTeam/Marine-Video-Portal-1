import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  formatTimestamp,
  parseChapters,
  formatChaptersText,
  normalizeChapters,
  normalizeMeta,
  cleanNotes,
  metaMatches,
  MAX_NOTES_LENGTH,
  MAX_CHAPTERS,
} from '../videoMeta';

describe('parseTimestamp', () => {
  it('reads M:SS and MM:SS', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('4:05')).toBe(245);
    expect(parseTimestamp('24:15')).toBe(1455);
  });

  it('reads H:MM:SS', () => {
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('1:11:00')).toBe(4260);
  });

  // A service recording can legitimately run past an hour written as minutes.
  it('allows minutes past 59 when there is no hours field', () => {
    expect(parseTimestamp('90:00')).toBe(5400);
  });

  it('rejects out-of-range seconds and minutes', () => {
    expect(parseTimestamp('1:75')).toBeNull();
    expect(parseTimestamp('1:75:00')).toBeNull();
    expect(parseTimestamp('1:00:75')).toBeNull();
  });

  // "12" is far likelier to be a mistyped timestamp than a deliberate mark at
  // twelve seconds — better to report it than to silently misplace a chapter.
  it('rejects a bare number and other junk', () => {
    for (const bad of ['12', '', '   ', 'abc', '1:2:3:4', ':30', '1:', null, undefined]) {
      expect(parseTimestamp(bad)).toBeNull();
    }
  });
});

describe('formatTimestamp', () => {
  it('omits the hours field below an hour', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(245)).toBe('4:05');
    expect(formatTimestamp(1455)).toBe('24:15');
  });

  it('includes hours past an hour, zero-padding minutes', () => {
    expect(formatTimestamp(3723)).toBe('1:02:03');
    expect(formatTimestamp(5400)).toBe('1:30:00');
  });

  it('is a round trip with parseTimestamp', () => {
    for (const t of ['0:00', '4:05', '24:15', '1:02:03']) {
      expect(formatTimestamp(parseTimestamp(t))).toBe(t);
    }
  });

  it('handles junk without throwing', () => {
    expect(formatTimestamp(undefined)).toBe('0:00');
    expect(formatTimestamp(-5)).toBe('0:00');
  });
});

describe('parseChapters', () => {
  it('parses a typical service list', () => {
    const { chapters, ignored } = parseChapters(
      '0:00 Worship\n18:30 Announcements\n24:15 Sermon\n1:11:00 Communion'
    );
    expect(ignored).toEqual([]);
    expect(chapters).toEqual([
      { seconds: 0, label: 'Worship' },
      { seconds: 1110, label: 'Announcements' },
      { seconds: 1455, label: 'Sermon' },
      { seconds: 4260, label: 'Communion' },
    ]);
  });

  it('accepts dash, en-dash and colon separators', () => {
    const { chapters } = parseChapters('0:00 - Worship\n5:00 – Reading\n9:00 : Sermon');
    expect(chapters.map((c) => c.label)).toEqual(['Worship', 'Reading', 'Sermon']);
  });

  // The admin should not have to type them in order.
  it('sorts by timestamp regardless of input order', () => {
    const { chapters } = parseChapters('24:15 Sermon\n0:00 Worship\n18:30 Notices');
    expect(chapters.map((c) => c.seconds)).toEqual([0, 1110, 1455]);
  });

  // Reporting bad lines is the point — a silently short list is a support call.
  it('reports unparseable lines instead of dropping them silently', () => {
    const { chapters, ignored } = parseChapters('0:00 Worship\nsermon starts here\n1:75 Broken');
    expect(chapters).toHaveLength(1);
    expect(ignored).toEqual(['sermon starts here', '1:75 Broken']);
  });

  it('treats a timestamp with no label as unusable', () => {
    const { chapters, ignored } = parseChapters('12:00');
    expect(chapters).toEqual([]);
    expect(ignored).toEqual(['12:00']);
  });

  it('skips blank lines without reporting them', () => {
    const { chapters, ignored } = parseChapters('\n\n0:00 Worship\n\n  \n5:00 Sermon\n');
    expect(chapters).toHaveLength(2);
    expect(ignored).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(parseChapters(empty)).toEqual({ chapters: [], ignored: [] });
    }
  });

  it('caps the number of chapters', () => {
    const many = Array.from({ length: MAX_CHAPTERS + 20 }, (_, i) => `${i}:00 Chapter ${i}`).join('\n');
    expect(parseChapters(many).chapters).toHaveLength(MAX_CHAPTERS);
  });

  it('round-trips through formatChaptersText', () => {
    const text = '0:00 Worship\n24:15 Sermon\n1:11:00 Communion';
    expect(formatChaptersText(parseChapters(text).chapters)).toBe(text);
  });
});

describe('normalizeChapters', () => {
  it('drops malformed entries rather than throwing', () => {
    expect(
      normalizeChapters([
        { seconds: 10, label: 'Fine' },
        { seconds: 'nope', label: 'Bad seconds' },
        { seconds: 20 },
        { seconds: -5, label: 'Negative' },
        null,
      ])
    ).toEqual([{ seconds: 10, label: 'Fine' }]);
  });

  it('returns empty for a non-array', () => {
    expect(normalizeChapters(null)).toEqual([]);
    expect(normalizeChapters('0:00 Worship')).toEqual([]);
  });
});

describe('cleanNotes', () => {
  it('keeps paragraphs but collapses runs of blank lines', () => {
    expect(cleanNotes('First line\n\n\n\nSecond line')).toBe('First line\n\nSecond line');
  });

  it('strips control characters but keeps newlines', () => {
    expect(cleanNotes('Philippians 4:13\nKey verse')).toBe('Philippians 4:13\nKey verse');
  });

  it('clamps to the maximum length', () => {
    expect(cleanNotes('x'.repeat(MAX_NOTES_LENGTH + 500))).toHaveLength(MAX_NOTES_LENGTH);
  });

  it('returns empty for blank input', () => {
    for (const blank of ['', '   ', '\n\n', null, undefined]) {
      expect(cleanNotes(blank)).toBe('');
    }
  });
});

describe('normalizeMeta', () => {
  it('reads a stored JSON string and an already-parsed object', () => {
    const stored = { notes: 'On Philippians', chapters: [{ seconds: 0, label: 'Worship' }] };
    expect(normalizeMeta(JSON.stringify(stored))).toEqual(stored);
    expect(normalizeMeta(stored)).toEqual(stored);
  });

  // Empty entry == no entry, so listVideoMeta never returns dead rows.
  it('treats an entry with neither field as absent', () => {
    expect(normalizeMeta('{"notes":"","chapters":[]}')).toBeNull();
    expect(normalizeMeta(null)).toBeNull();
  });

  it('survives malformed JSON', () => {
    expect(normalizeMeta('{not json')).toBeNull();
  });
});

describe('metaMatches', () => {
  const meta = { notes: 'A talk on Philippians 4', chapters: [] };

  it('matches a word that appears only in the notes', () => {
    expect(metaMatches(meta, 'philippians')).toBe(true);
  });

  it('does not match an unrelated term', () => {
    expect(metaMatches(meta, 'romans')).toBe(false);
  });

  it('handles missing metadata or an empty query', () => {
    expect(metaMatches(null, 'philippians')).toBe(false);
    expect(metaMatches(meta, '')).toBe(false);
  });
});
