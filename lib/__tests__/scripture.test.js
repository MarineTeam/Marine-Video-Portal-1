// lib/scripture.js — reading passages out of titles and notes, and matching a
// typed passage against them.
//
// Two failure directions, and the tests are split by them. MISSING a
// reference costs a viewer a sermon they were looking for; INVENTING one puts
// a link to "Mark 20" under a talk about a 2020 report. The second is worse,
// because it is visible and wrong, so the false-positive block is as long as
// the recognition one.
import { describe, expect, it } from 'vitest';
import {
  bookIndex,
  bookInfo,
  compareReferences,
  formatReference,
  MAX_REFERENCES,
  parsePassageQuery,
  parseReferences,
  passageMatches,
  referencesOverlap,
  videoMatchesPassage,
  videoReferences,
} from '../scripture';

const refs = (text, opts) => parseReferences(text, opts).map(formatReference);

describe('recognising references', () => {
  it.each([
    ['Philippians 2:1-11', 'Philippians 2:1–11'],
    ['Phil 2:1-11', 'Philippians 2:1–11'],
    ['Php 2:5', 'Philippians 2:5'],
    ['Phil. 4:13', 'Philippians 4:13'],
    ['Philippians 1:27–2:11', 'Philippians 1:27–2:11'],
    ['John 3:16', 'John 3:16'],
    ['Jn 3:16', 'John 3:16'],
    ['John 3', 'John 3'],
    ['John 3-4', 'John 3–4'],
    ['1 Cor 13', '1 Corinthians 13'],
    ['1Cor 13:4-7', '1 Corinthians 13:4–7'],
    ['I Corinthians 13', '1 Corinthians 13'],
    ['First John 4:8', '1 John 4:8'],
    ['1st John 4:8', '1 John 4:8'],
    ['II Tim 3:16', '2 Timothy 3:16'],
    ['2nd Timothy 3:16', '2 Timothy 3:16'],
    ['3 John 4', '3 John 4'],
    ['Ps 23', 'Psalms 23'],
    ['Psalm 119:105', 'Psalms 119:105'],
    ['Song of Solomon 2:4', 'Song of Songs 2:4'],
    ['Heb. 11:1', 'Hebrews 11:1'],
    ['Rev 22:21', 'Revelation 22:21'],
    ['Gen 1:1–2:3', 'Genesis 1:1–2:3'],
    ['Romans 8:28a', 'Romans 8:28'],
    ['John 3.16', 'John 3:16'],
    ['Isaiah 53:5', 'Isaiah 53:5'],
    ['Isa 53', 'Isaiah 53'],
    ['Ezek 37', 'Ezekiel 37'],
    ['Esth 4:14', 'Esther 4:14'],
    ['Second Peter 1:3', '2 Peter 1:3'],
    ['III John 4', '3 John 4'],
  ])('%s', (text, expected) => {
    expect(refs(text)).toEqual([expected]);
  });

  // Every canonical name, capitalised as written, must read as itself. This is
  // the test that caught the numeral check stripping the I off "Isaiah".
  it('recognises all 66 books by their own names', () => {
    const all = 'Genesis Exodus Leviticus Numbers Deuteronomy Joshua Judges Ruth|1 Samuel|2 Samuel|1 Kings|2 Kings|1 Chronicles|2 Chronicles|Ezra Nehemiah Esther Job Psalms Proverbs Ecclesiastes|Song of Songs|Isaiah Jeremiah Lamentations Ezekiel Daniel Hosea Joel Amos Obadiah Jonah Micah Nahum Habakkuk Zephaniah Haggai Zechariah Malachi Matthew Mark Luke John Acts Romans|1 Corinthians|2 Corinthians|Galatians Ephesians Philippians Colossians|1 Thessalonians|2 Thessalonians|1 Timothy|2 Timothy|Titus Philemon Hebrews James|1 Peter|2 Peter|1 John|2 John|3 John|Jude Revelation'
      .split('|')
      .flatMap((chunk) => (/^\d|^Song/.test(chunk) ? [chunk] : chunk.split(' ')));
    expect(all).toHaveLength(66);
    for (const name of all) {
      expect(refs(`${name} 1`), name).toEqual([`${name} 1`]);
    }
  });

  it('reads a one-chapter book\'s lone number as a verse', () => {
    expect(refs('Jude 3')).toEqual(['Jude 3']);
    expect(parseReferences('Jude 3')[0]).toMatchObject({ chapter: 1, verse: 3 });
    expect(refs('Philemon 6')).toEqual(['Philemon 6']);
    expect(refs('Jude 1:3')).toEqual(['Jude 3']);
  });

  it('follows comma and semicolon continuations in the same book', () => {
    expect(refs('Romans 8:28, 31-39; 9:1')).toEqual([
      'Romans 8:28',
      'Romans 8:31–39',
      'Romans 9:1',
    ]);
  });

  it('finds several references in running notes, in the order written', () => {
    const notes = 'Text: Phil 2:1-11\nSee also John 13:1–17 and Mark 10:45.';
    expect(refs(notes)).toEqual(['Philippians 2:1–11', 'John 13:1–17', 'Mark 10:45']);
  });

  it('keeps each passage once', () => {
    expect(refs('Phil 2:5 … Philippians 2:5 … Php 2:5')).toEqual(['Philippians 2:5']);
  });

  it('stops at the cap rather than producing a wall of links', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Ps ${i + 1}`).join(', ');
    expect(parseReferences(many)).toHaveLength(MAX_REFERENCES);
  });

  it('keeps the start of a range that runs backwards', () => {
    expect(refs('Phil 2:11-1')).toEqual(['Philippians 2:11']);
  });
});

describe('NOT inventing references', () => {
  it.each([
    ['a four-digit year after a book name', 'Mark 2023 annual report'],
    ['a chapter past Mark\'s sixteen', 'Mark 20 years on'],
    ['a chapter the book does not have', 'Acts 29 network'],
    ['a chapter past 1 John\'s five — not rescued as John 6', '1 John 6'],
    ['a lowercase word that is also a book', 'numbers 1 to 10'],
    ['lowercase job', 'the job 3 years ago'],
    ['\'Is\' is not Isaiah', 'Is 5 enough?'],
    ['\'LA\' is not Lamentations', 'LA 2 office'],
    ['\'Re\' is not Revelation', 'Re 5 items'],
    ['a book name with no chapter', 'Mark said to John'],
    ['a reference glued into a URL', 'https://example.com/John3:16'],
    ['a verse past the longest chapter', 'John 3:200'],
    ['a book name inside a longer word', 'Johnson 3'],
  ])('%s', (_why, text) => {
    expect(refs(text)).toEqual([]);
  });

  it('reads a book name case-insensitively only when asked to', () => {
    expect(refs('phil 2')).toEqual([]);
    expect(refs('phil 2', { strict: false })).toEqual(['Philippians 2']);
  });

  it('treats non-text input as nothing', () => {
    expect(parseReferences(null)).toEqual([]);
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences(42)).toEqual([]);
  });
});

describe('overlap', () => {
  const one = (text) => parseReferences(text)[0];

  it('matches passages that share any verse', () => {
    expect(referencesOverlap(one('Phil 1:27-2:11'), one('Phil 2:5'))).toBe(true);
    expect(referencesOverlap(one('Phil 2'), one('Phil 2:30'))).toBe(true);
    expect(referencesOverlap(one('John 3-4'), one('John 4:7'))).toBe(true);
  });

  it('does not match neighbours or other books', () => {
    expect(referencesOverlap(one('Phil 2:1-11'), one('Phil 2:12'))).toBe(false);
    expect(referencesOverlap(one('Phil 2'), one('Phil 3:1'))).toBe(false);
    expect(referencesOverlap(one('John 3:16'), one('1 John 3:16'))).toBe(false);
  });
});

describe('a typed search as a passage', () => {
  it('reads a book spelled out as the whole book', () => {
    expect(parsePassageQuery('Philippians')).toEqual({ book: 'Philippians' });
    expect(parsePassageQuery('philippians')).toEqual({ book: 'Philippians' });
    expect(parsePassageQuery('1 John')).toEqual({ book: '1 John' });
    expect(parsePassageQuery('psalm')).toEqual({ book: 'Psalms' });
  });

  it('does NOT read an abbreviation alone as a book — \'phil\' is a person', () => {
    expect(parsePassageQuery('phil')).toBeNull();
    expect(parsePassageQuery('Rom')).toBeNull();
  });

  it('reads a passage, however it is cased', () => {
    expect(parsePassageQuery('phil 2')).toMatchObject({ book: 'Philippians', ref: { chapter: 2 } });
    expect(parsePassageQuery('Philippians 2:1–11')?.ref).toMatchObject({ verse: 1, endVerse: 11 });
  });

  it('only when the WHOLE query is the reference', () => {
    expect(parsePassageQuery('sermon on Phil 2')).toBeNull();
    expect(parsePassageQuery('Phil 2 notes')).toBeNull();
    expect(parsePassageQuery('Phil 2, 3')).toBeNull();
  });

  it('reads what formatReference writes, so a passage link round-trips', () => {
    for (const text of ['Philippians 1:27–2:11', 'Jude 3', 'John 3–4', '1 Corinthians 13:4–7']) {
      const ref = parseReferences(text)[0];
      expect(parsePassageQuery(formatReference(ref))?.ref).toEqual(ref);
    }
  });

  it('matches against a video\'s references', () => {
    const cited = parseReferences('Phil 1:27-2:11');
    expect(passageMatches(cited, parsePassageQuery('Philippians'))).toBe(true);
    expect(passageMatches(cited, parsePassageQuery('Philippians 2'))).toBe(true);
    expect(passageMatches(cited, parsePassageQuery('Philippians 3'))).toBe(false);
    expect(passageMatches(cited, null)).toBe(false);
  });
});

describe('helpers', () => {
  it('reads a video\'s title and notes together', () => {
    expect(videoReferences({ title: 'Phil 2 — Humility', notes: 'Also John 13' }).map(formatReference)).toEqual([
      'Philippians 2',
      'John 13',
    ]);
    expect(videoReferences(null)).toEqual([]);
  });

  it('sorts in Bible order', () => {
    const sorted = parseReferences('Rev 1, John 3:16, Gen 1, John 1').sort(compareReferences).map(formatReference);
    expect(sorted).toEqual(['Genesis 1', 'John 1', 'John 3:16', 'Revelation 1']);
  });

  it('knows every book\'s chapter count', () => {
    expect(bookInfo('Psalms').chapters).toBe(150);
    expect(bookInfo('Jude').chapters).toBe(1);
    expect(bookInfo('Nope')).toBeNull();
  });
});

describe('videoMatchesPassage', () => {
  it('reads the title and notes together, with the query parsed once by the caller', () => {
    const passage = parsePassageQuery('Philippians 2');
    expect(videoMatchesPassage('Humility', 'Phil 1:27-2:11', passage)).toBe(true);
    expect(videoMatchesPassage('Phil 2:5', '', passage)).toBe(true);
    expect(videoMatchesPassage('Harbour tour', null, passage)).toBe(false);
    expect(videoMatchesPassage('Phil 2', '', null)).toBe(false);
  });
});

describe('bookIndex', () => {
  const videos = [
    { title: 'Humility', notes: 'Phil 2:1-11, and again Philippians 2:5' },
    { title: 'Joy — Phil 4:4', notes: 'Also John 15:11' },
    { title: 'Harbour tour', notes: null },
    { title: 'Genesis 1', notes: '' },
  ];

  it('counts VIDEOS per book, not references, in Bible order', () => {
    expect(bookIndex(videos)).toEqual([
      { book: 'Genesis', count: 1 },
      { book: 'John', count: 1 },
      { book: 'Philippians', count: 2 },
    ]);
  });

  it('reads from whatever source the caller\'s search matches', () => {
    const notesOnly = (v) => parseReferences(v.notes || '');
    expect(bookIndex(videos, notesOnly).map((b) => b.book)).toEqual(['John', 'Philippians']);
  });

  it('is empty for nothing', () => {
    expect(bookIndex([])).toEqual([]);
    expect(bookIndex(null)).toEqual([]);
  });

  it('lists only books whose name, searched, finds those same videos', () => {
    // The homepage searches a book by its name; the passage search must read
    // that name as the whole book, or a listed book would find nothing.
    for (const { book } of bookIndex(videos)) {
      expect(parsePassageQuery(book)).toEqual({ book });
    }
  });
});
