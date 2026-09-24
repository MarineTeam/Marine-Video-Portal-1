// Word stems for search: "baptism", "baptise", "baptized" and "baptizing" are
// one search, not four.
//
// PURE — no imports. Used by /api/videos only today, but kept free of regex
// lookbehind like lib/scripture.js, so it stays safe to bundle client-side
// (lookbehind is a parse-time SyntaxError in Safari before 16.4).
//
// DELIBERATELY SMALL. This is not a Porter stemmer; it strips a short list of
// English endings and is tested word by word. A stemmer's failure mode is
// CONFLATION — "Peter" and "pet", "water" and "wat" — and in a search box that
// reads as the search being broken. So:
//   - endings that are also ordinary word-final letters ("-er", "-en", "-al")
//     are not stripped at all;
//   - a stem is never left shorter than three letters ("king" stays "king",
//     not "k"; "wise" stays "wise");
//   - matching is WORD EQUALITY of stems, never substring, so a short stem
//     cannot match the inside of a longer word.
// It only ever ADDS matches to the substring search it sits beside.

const MIN_STEM = 3;

// [ending, replacement], longest first. British and American spellings strip
// to the same stem, which is the point: "baptise" / "baptize".
const ENDINGS = [
  ['izations', ''],
  ['isations', ''],
  ['ization', ''],
  ['isation', ''],
  ['nesses', ''],
  ['izing', ''],
  ['ising', ''],
  ['ments', ''],
  ['ized', ''],
  ['ised', ''],
  ['izes', ''],
  ['ises', ''],
  ['isms', ''],
  ['ists', ''],
  ['ness', ''],
  ['ment', ''],
  ['ings', ''],
  ['edly', ''],
  ['ize', ''],
  ['ise', ''],
  ['ism', ''],
  ['ist', ''],
  ['ing', ''],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ed', ''],
  ['es', ''],
  ['s', ''],
];

// A final "s" that is part of the word, not a plural: "Jesus", "grass",
// "Genesis", "was".
const KEEP_FINAL_S = /(ss|us|is|as)$/;

// Doubled consonants left by stripping "-ing"/"-ed": "running" -> "runn" ->
// "run", "stopped" -> "stop". Not l, s or z, which double in the base word
// ("fall", "pass", "buzz").
const DOUBLED = /([b-df-hj-km-np-rtv-y])\1$/;

export function stem(word) {
  let w = String(word || '').toLowerCase();
  // Short words are left alone except for the y -> i fold, so "cry" still
  // meets "cried" and "cries".
  if (w.length <= MIN_STEM) return w.length === MIN_STEM && w.endsWith('y') ? `${w.slice(0, -1)}i` : w;
  for (const [ending, replacement] of ENDINGS) {
    if (!w.endsWith(ending)) continue;
    if (ending === 's' && KEEP_FINAL_S.test(w)) break;
    const base = w.slice(0, -ending.length) + replacement;
    if (base.length < MIN_STEM) continue;
    w = base;
    if ((ending === 'ing' || ending === 'ed') && DOUBLED.test(w)) w = w.slice(0, -1);
    break;
  }
  // "forgive"/"forgiving", "judge"/"judgment", "hope"/"hoping".
  if (w.length > MIN_STEM && w.endsWith('e')) w = w.slice(0, -1);
  // "holy"/"holiness", "cry"/"cried", "city"/"cities".
  if (w.length >= MIN_STEM && w.endsWith('y')) w = `${w.slice(0, -1)}i`;
  return w;
}

const APOSTROPHE = /['‘’ʼ]/g;
const NOT_WORD = /[^\p{L}\p{N}]+/u;

export function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(APOSTROPHE, '')
    .split(NOT_WORD)
    .filter(Boolean);
}

export function stemSet(text) {
  return new Set(words(text).map(stem));
}

// Words that carry no meaning in a search and would only make a multi-word
// query harder to satisfy. Short on purpose.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'our', 'his', 'her']);

// The stems a query needs, or [] when it has nothing to stem on. Words under
// three letters are ignored — they either stem to themselves or are noise —
// EXCEPT numbers, which are kept whole: "psalm 23" must need the 23, or it
// would find every psalm.
const NUMBER = /^\p{N}+$/u;
export function queryStems(query) {
  return [
    ...new Set(
      words(query)
        .filter((w) => NUMBER.test(w) || (w.length >= MIN_STEM && !STOPWORDS.has(w)))
        .map((w) => (NUMBER.test(w) ? w : stem(w)))
    ),
  ];
}

// Whether every meaningful word of the query appears, as a stem, somewhere in
// the text. Order-free: "baptism jesus" finds "Jesus was baptized".
export function stemsMatch(textStems, needed) {
  if (!needed || needed.length === 0) return false;
  return needed.every((s) => textStems.has(s));
}
