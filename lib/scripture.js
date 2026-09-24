// Scripture references in titles and notes: "Phil 2:1-11", "1 Cor 13",
// "Romans 8:28, 31-39", "Jude 3".
//
// PURE — imports nothing: the watch page renders a video's passages during
// render, so this lands in the client bundle (same rule as lib/videoMeta.js).
// /api/videos matches titles and notes through videoMatchesPassage below.
//
// WHAT THIS IS FOR. Notes and titles were plain text, so "every sermon on
// Philippians" meant hoping everyone had spelled it the same way — "Phil",
// "Php" and "Philippians" were three different searches, and a talk on
// Philippians 1:27–2:11 was invisible to a search for "Philippians 2". This
// reads references out of the text so a passage search finds overlapping
// passages however they were written.
//
// WHAT IT DELIBERATELY IS NOT:
//   - No translation handling. "John 3:16 (ESV)" is John 3:16; which
//     translation was read is not a different passage.
//   - No verse-count table. Chapters are checked against each book's length
//     (that is what stops "Mark 2023" or "Acts 29" reading as a reference),
//     but verses only against a ceiling of 176, the longest chapter there is.
//   - The 66-book Protestant canon only. A library that preaches from the
//     Apocrypha would need those books added; nothing here would break.
//
// FALSE POSITIVES ARE THE REAL RISK, so in titles and notes a reference needs
//   (a) a chapter number — "Mark" or "Job" alone is a word, not a passage;
//   (b) a capitalised book name — "numbers 1 to 10" and "job 3" are prose;
//   (c) a chapter that exists in that book.
// Two-letter abbreviations that are ordinary capitalised words or common
// initials ("Is", "Am", "So", "Re", "La") are left out entirely: "Is 5
// enough?" should not be Isaiah 5, nor "LA 2" Lamentations. A typed search is read more generously (case-insensitive),
// because a viewer who types "phil 2" in the search box means the passage.

// [canonical name, chapters, ...other spellings]. Numbered books list the
// stem once; the numeral forms ("1", "I", "1st", "First") are generated.
const BOOKS = [
  ['Genesis', 50, 'Gen', 'Ge', 'Gn'],
  ['Exodus', 40, 'Exod', 'Exo', 'Ex'],
  ['Leviticus', 27, 'Lev', 'Le', 'Lv'],
  ['Numbers', 36, 'Num', 'Nu', 'Nm', 'Nb'],
  ['Deuteronomy', 34, 'Deut', 'Dt', 'De'],
  ['Joshua', 24, 'Josh', 'Jos', 'Jsh'],
  ['Judges', 21, 'Judg', 'Jdg', 'Jg', 'Jdgs'],
  ['Ruth', 4, 'Rth', 'Ru'],
  ['1 Samuel', 31],
  ['2 Samuel', 24],
  ['1 Kings', 22],
  ['2 Kings', 25],
  ['1 Chronicles', 29],
  ['2 Chronicles', 36],
  ['Ezra', 10, 'Ezr'],
  ['Nehemiah', 13, 'Neh', 'Ne'],
  ['Esther', 10, 'Esth', 'Est'],
  ['Job', 42, 'Jb'],
  ['Psalms', 150, 'Psalm', 'Ps', 'Psa', 'Pss', 'Psm'],
  ['Proverbs', 31, 'Prov', 'Pro', 'Prv', 'Pr'],
  ['Ecclesiastes', 12, 'Eccles', 'Eccl', 'Ecc', 'Ec', 'Qoh'],
  ['Song of Songs', 8, 'Song of Solomon', 'Song', 'SoS', 'Canticles', 'Cant'],
  ['Isaiah', 66, 'Isa'],
  ['Jeremiah', 52, 'Jer', 'Je', 'Jr'],
  ['Lamentations', 5, 'Lam'],
  ['Ezekiel', 48, 'Ezek', 'Eze', 'Ezk'],
  ['Daniel', 12, 'Dan', 'Dn'],
  ['Hosea', 14, 'Hos'],
  ['Joel', 3, 'Jl'],
  ['Amos', 9],
  ['Obadiah', 1, 'Obad', 'Ob'],
  ['Jonah', 4, 'Jon', 'Jnh'],
  ['Micah', 7, 'Mic', 'Mc'],
  ['Nahum', 3, 'Nah'],
  ['Habakkuk', 3, 'Hab', 'Hb'],
  ['Zephaniah', 3, 'Zeph', 'Zep', 'Zp'],
  ['Haggai', 2, 'Hag', 'Hg'],
  ['Zechariah', 14, 'Zech', 'Zec', 'Zc'],
  ['Malachi', 4, 'Mal', 'Ml'],
  ['Matthew', 28, 'Matt', 'Mat', 'Mt'],
  ['Mark', 16, 'Mrk', 'Mk'],
  ['Luke', 24, 'Luk', 'Lk'],
  ['John', 21, 'Jhn', 'Joh', 'Jn'],
  ['Acts', 28, 'Act'],
  ['Romans', 16, 'Rom', 'Ro', 'Rm'],
  ['1 Corinthians', 16],
  ['2 Corinthians', 13],
  ['Galatians', 6, 'Gal', 'Ga'],
  ['Ephesians', 6, 'Ephes', 'Eph'],
  ['Philippians', 4, 'Phil', 'Php', 'Pp'],
  ['Colossians', 4, 'Col'],
  ['1 Thessalonians', 5],
  ['2 Thessalonians', 3],
  ['1 Timothy', 6],
  ['2 Timothy', 4],
  ['Titus', 3, 'Tit'],
  ['Philemon', 1, 'Philem', 'Phlm', 'Phm'],
  ['Hebrews', 13, 'Heb'],
  ['James', 5, 'Jas', 'Jm'],
  ['1 Peter', 5],
  ['2 Peter', 3],
  ['1 John', 5],
  ['2 John', 1],
  ['3 John', 1],
  ['Jude', 1, 'Jud', 'Jd'],
  ['Revelation', 22, 'Revelations', 'Rev', 'Apocalypse'],
];

// The stems a numbered book is written with after its numeral.
const NUMBERED_STEMS = {
  Samuel: ['Samuel', 'Sam', 'Sa', 'Sm'],
  Kings: ['Kings', 'Kgs', 'Ki', 'Kin'],
  Chronicles: ['Chronicles', 'Chron', 'Chr', 'Ch'],
  Corinthians: ['Corinthians', 'Cor', 'Co'],
  Thessalonians: ['Thessalonians', 'Thess', 'Thes', 'Th'],
  Timothy: ['Timothy', 'Tim', 'Ti'],
  Peter: ['Peter', 'Pet', 'Pe', 'Pt'],
  John: ['John', 'Jn', 'Jhn', 'Jo'],
};

const NUMERALS = {
  1: ['1', 'I', '1st', 'First'],
  2: ['2', 'II', '2nd', 'Second'],
  3: ['3', 'III', '3rd', 'Third'],
};

// Longest real chapter (Psalm 119). A verse past this is a date or a page
// number, not a verse.
export const MAX_VERSE = 176;

// The most passages one video's text yields. Notes are clamped already; this
// just keeps a pathological paste from producing a wall of links.
export const MAX_REFERENCES = 24;

const BOOK_INFO = new Map(); // canonical name -> { name, chapters, order }
const ALIAS_TO_BOOK = new Map(); // lowercased spelling (spaces collapsed) -> canonical
const FULL_NAMES = new Set(); // lowercased spellings that name a book on their own

function addAlias(alias, book, full) {
  const key = alias.toLowerCase().replace(/\s+/g, ' ');
  ALIAS_TO_BOOK.set(key, book);
  if (full) FULL_NAMES.add(key);
}

BOOKS.forEach(([name, chapters, ...aliases], order) => {
  BOOK_INFO.set(name, { name, chapters, order });
  const numbered = name.match(/^([123]) (.+)$/);
  if (numbered) {
    const [, n, stem] = numbered;
    for (const numeral of NUMERALS[n]) {
      for (const s of NUMBERED_STEMS[stem]) {
        const full = s === stem;
        addAlias(`${numeral} ${s}`, name, full);
        // "1Cor", "1John" — written without the space. Not for the word
        // numerals: "FirstJohn" is not how anyone writes it.
        if (/^\d/.test(numeral)) addAlias(`${numeral}${s}`, name, full);
      }
    }
    return;
  }
  addAlias(name, name, true);
  for (const alias of aliases) {
    // A spelled-out alternative ("Psalm", "Song of Solomon", "Revelations")
    // names the book on its own; an abbreviation does not.
    const full = alias.length >= 5 || alias === 'Psalm';
    addAlias(alias, name, full);
  }
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling, longest first so "1 John" wins over "John" and "Philem"
// over "Phil". Internal spaces match any run of whitespace.
const ALIAS_PATTERN = [...ALIAS_TO_BOOK.keys()]
  .sort((a, b) => b.length - a.length)
  .map((a) => escape(a).replace(/ /g, '\\s+'))
  .join('|');

const DASH = '\\s*[-–—]\\s*';
// book, then chapter, then optional :verse, then an optional range that is
// either -verse or -chapter:verse. A trailing a/b/c ("v. 5a") is ignored.
//
// NO LOOKBEHIND. The homepage bundles this module, and a lookbehind is a
// SyntaxError at parse time in Safari before 16.4 — the whole library page
// would fail to load on an older iPhone, not just this feature. The boundary
// before the book is captured as group 1 instead, and callers step past it.
const REFERENCE = new RegExp(
  `(^|[^\\p{L}\\p{N}/])(${ALIAS_PATTERN})\\.?\\s*(\\d{1,3})(?:[:.](\\d{1,3})[abc]?)?(?:${DASH}(\\d{1,3})(?:[:.](\\d{1,3})[abc]?)?)?(?![\\p{L}\\p{N}])`,
  'giu'
);
// After a reference: ", 31-39" (more verses, same chapter) or "; 9:1" (same
// book, another chapter). Anchored with the sticky flag at the end of the
// previous match.
const CONTINUATION = new RegExp(
  `\\s*([,;])\\s*(\\d{1,3})(?:[:.](\\d{1,3})[abc]?)?(?:${DASH}(\\d{1,3})(?:[:.](\\d{1,3})[abc]?)?)?(?![\\p{L}\\p{N}:.])`,
  'yu'
);

export function bookInfo(name) {
  return BOOK_INFO.get(name) || null;
}

function lookupBook(alias) {
  return ALIAS_TO_BOOK.get(String(alias).toLowerCase().replace(/\s+/g, ' ')) || null;
}

const num = (s) => (s === undefined ? null : Number(s));

// Turns the numbers of one match into a reference, or null if they cannot be
// one (a chapter the book does not have, a verse past 176, a range that runs
// backwards). A range that runs backwards keeps its start: "Phil 2:11-1" is
// more likely a typo in the end than a reference to nothing.
function build(book, chapter, verse, endA, endB) {
  const info = BOOK_INFO.get(book);
  if (!info) return null;
  const verseOk = (v) => v === null || (v >= 1 && v <= MAX_VERSE);

  // A one-chapter book's lone number is a verse: "Jude 3" is Jude 1:3, and
  // "Jude 1" is its first verse, not the whole letter.
  if (info.chapters === 1 && verse === null) {
    if (endB !== null) return null;
    return build(book, 1, chapter, endA, null);
  }
  if (chapter < 1 || chapter > info.chapters || !verseOk(verse)) return null;

  let endChapter = chapter;
  let endVerse = verse;
  if (endA !== null) {
    if (endB !== null) {
      // "1:27-2:11"
      endChapter = endA;
      endVerse = endB;
    } else if (verse !== null) {
      // "2:1-11"
      endVerse = endA;
    } else {
      // "John 3-4": whole chapters
      endChapter = endA;
      endVerse = null;
    }
    const valid =
      endChapter >= 1 &&
      endChapter <= info.chapters &&
      verseOk(endVerse) &&
      (endChapter > chapter || (endChapter === chapter && (endVerse ?? MAX_VERSE) >= (verse ?? 0)));
    if (!valid) {
      endChapter = chapter;
      endVerse = verse;
    }
  }
  return { book, chapter, verse, endChapter, endVerse };
}

// Whether the book NAME in a match starts with a capital letter. The numeral
// is stepped over first, so "1st John 3" passes on the J (not failing on the
// s of "1st") and "1 john 3" fails.
// A word numeral must be followed by a space — otherwise the I of "Isaiah"
// would be read as a numeral and the check would land on its lowercase s.
const NUMERAL_PREFIX = /^(?:[123](?:st|nd|rd)?\s*|(?:I{1,3}|First|Second|Third)\s+)/i;
function capitalised(text) {
  const letter = String(text).replace(NUMERAL_PREFIX, '').match(/\p{L}/u);
  return Boolean(letter) && letter[0] === letter[0].toUpperCase() && letter[0] !== letter[0].toLowerCase();
}

// Every reference in a piece of text, in the order written, duplicates kept
// out. `strict` (the default, for titles and notes) requires a capitalised
// book name; a typed search passes strict: false.
export function parseReferences(text, { strict = true } = {}) {
  const source = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    if (!ref || out.length >= MAX_REFERENCES) return;
    const key = formatReference(ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  REFERENCE.lastIndex = 0;
  let match;
  while ((match = REFERENCE.exec(source)) && out.length < MAX_REFERENCES) {
    // A failed match resumes after its whole text, never inside it: "1 John
    // 6" is not a reference (1 John has five chapters), and resuming at
    // "John 6" would invent one the author never wrote.
    const [whole, , alias, c, v, a, b] = match;
    if (strict && !capitalised(alias)) continue;
    const book = lookupBook(alias);
    let ref = build(book, num(c), num(v), num(a), num(b));
    if (!ref) continue;
    push(ref);

    // Continuations share the book, and a bare number after a comma is a
    // verse in the chapter the previous reference ENDED in.
    CONTINUATION.lastIndex = match.index + whole.length;
    let more;
    while ((more = CONTINUATION.exec(source))) {
      const [, sep, x, y, z, w] = more;
      let next;
      if (sep === ',' && y === undefined && ref.endVerse !== null) {
        next = build(book, ref.endChapter, num(x), num(z), num(w));
      } else if (y !== undefined) {
        next = build(book, num(x), num(y), num(z), num(w));
      } else {
        break;
      }
      if (!next) break;
      push(next);
      ref = next;
      REFERENCE.lastIndex = CONTINUATION.lastIndex;
    }
  }
  return out;
}

// "Philippians 2:1–11", "Philippians 1:27–2:11", "John 3–4", "Psalms 23",
// "Jude 3". An en dash, as a typesetter would. parseReferences reads it back.
export function formatReference(ref) {
  if (!ref) return '';
  const info = BOOK_INFO.get(ref.book);
  const single = info?.chapters === 1;
  const at = (c, v) => (single ? (v === null ? '' : `${v}`) : v === null ? `${c}` : `${c}:${v}`);
  const start = at(ref.chapter, ref.verse);
  const sameStart = ref.endChapter === ref.chapter && ref.endVerse === ref.verse;
  let end = '';
  if (!sameStart) {
    end = ref.endChapter === ref.chapter && ref.verse !== null ? `${ref.endVerse}` : at(ref.endChapter, ref.endVerse);
  }
  const passage = end ? `${start}–${end}` : start;
  return passage ? `${ref.book} ${passage}` : ref.book;
}

// A reference as a span of verse positions, so overlap is one comparison. A
// whole chapter is verse 0 to the ceiling.
function span(ref) {
  const start = ref.chapter * 1000 + (ref.verse ?? 0);
  const end = ref.endChapter * 1000 + (ref.endVerse ?? 999);
  return [start, end];
}

export function referencesOverlap(a, b) {
  if (!a || !b || a.book !== b.book) return false;
  const [s1, e1] = span(a);
  const [s2, e2] = span(b);
  return s1 <= e2 && s2 <= e1;
}

// What a typed search means as scripture, if anything:
//   "Philippians" / "1 John" / "Psalm"  -> { book }        the whole book
//   "phil 2" / "Phil 1:27-2:11"          -> { book, ref }   that passage
//   anything else                        -> null
// A book alone must be SPELLED OUT: "phil" is far more likely a person than
// Philippians, and "Mark" or "John" spelled out is still a book here because
// the plain-text half of the search keeps matching the name as well. The
// whole query must be the reference — "sermon on Phil 2" is a phrase, and
// the ordinary search already handles phrases.
export function parsePassageQuery(query) {
  const q = String(query || '').trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const bare = q.replace(/\.$/, '').toLowerCase();
  if (FULL_NAMES.has(bare)) return { book: ALIAS_TO_BOOK.get(bare) };
  const refs = parseReferences(q, { strict: false });
  if (refs.length !== 1) return null;
  // Confirm the reference IS the query, not a reference inside it.
  REFERENCE.lastIndex = 0;
  const m = REFERENCE.exec(q);
  if (!m || m.index !== 0 || m[1] !== '' || m[0].length !== q.length) return null;
  return { book: refs[0].book, ref: refs[0] };
}

// Whether any reference in `refs` is covered by a parsed passage query.
export function passageMatches(refs, passage) {
  if (!passage) return false;
  return (refs || []).some((r) =>
    passage.ref ? referencesOverlap(r, passage.ref) : r.book === passage.book
  );
}

// A video's references, from its title and notes together.
export function videoReferences(video) {
  return parseReferences(`${video?.title || ''}\n${video?.notes || ''}`);
}

// Canonical order (Genesis first), then chapter and verse — for listing a
// video's passages the way a Bible would.
export function compareReferences(a, b) {
  const oa = BOOK_INFO.get(a.book)?.order ?? 999;
  const ob = BOOK_INFO.get(b.book)?.order ?? 999;
  if (oa !== ob) return oa - ob;
  return span(a)[0] - span(b)[0];
}

// Whether a video's title or notes cite a passage overlapping a parsed query.
// /api/videos calls this with the query parsed ONCE per search.
export function videoMatchesPassage(title, notes, passage) {
  if (!passage) return false;
  return passageMatches(parseReferences(`${title || ''}\n${notes || ''}`), passage);
}

// The books a set of videos cites, each with how many VIDEOS cite it (a talk
// quoting Philippians three times counts once), in Bible order. `refsOf`
// says where a video's references come from — the same source the passage
// search matches, so a book listed here is a book that clicking will find.
//
// The caller decides WHICH videos: always the viewer's already-filtered
// library. A count is itself information — "Philippians (3)" says three
// videos exist — so an index over videos the viewer cannot see would leak
// exactly what the group and schedule filters exist to hide.
export function bookIndex(videos, refsOf = videoReferences) {
  const counts = new Map();
  for (const video of videos || []) {
    const books = new Set(refsOf(video).map((ref) => ref.book));
    for (const book of books) counts.set(book, (counts.get(book) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([book, count]) => ({ book, count }))
    .sort((a, b) => (BOOK_INFO.get(a.book)?.order ?? 999) - (BOOK_INFO.get(b.book)?.order ?? 999));
}
