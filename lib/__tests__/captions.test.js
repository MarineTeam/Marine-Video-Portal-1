// lib/captions.js — WebVTT parsing and transcript search.
//
// The cases that matter here are the ones a real bunny.net caption file will
// actually contain: CRLF line endings, <v Speaker> markup, two-digit vs
// three-digit millisecond fields, and cue text spanning several lines. A parser
// that only handles the tidy example in the spec will silently drop half a
// sermon.
import { describe, expect, it } from 'vitest';
import {
  MAX_CUES,
  cueAt,
  findCues,
  formatTimestamp,
  languageMissing,
  matchingTranscriptGuids,
  normalizeLanguages,
  parseVtt,
  pickLanguage,
  transcriptMatches,
  transcriptText,
} from '../captions';

const SAMPLE = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Welcome to the service this morning.

2
00:00:04.500 --> 00:00:09.250
Let us turn together to the book of Philippians.

3
01:02:03.100 --> 01:02:06.000
And that is the whole of it. Amen.
`;

describe("parseVtt", () => {
  it("parses cues with their timings and text", () => {
    const cues = parseVtt(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({
      start: 1,
      end: 4,
      text: "Welcome to the service this morning.",
    });
    expect(cues[1].start).toBeCloseTo(4.5);
    expect(cues[1].end).toBeCloseTo(9.25);
  });

  it("handles an hours field", () => {
    const cues = parseVtt(SAMPLE);
    // 01:02:03.100 -> 3723.1s
    expect(cues[2].start).toBeCloseTo(3723.1);
  });

  // A real file from a Windows-side tool, or from an HTTP response that kept
  // its CRLFs, must not leave a stray \r on every line.
  it("normalises CRLF and lone CR line endings", () => {
    const crlf = parseVtt(SAMPLE.replace(/\n/g, "\r\n"));
    expect(crlf).toHaveLength(3);
    expect(crlf[0].text).toBe("Welcome to the service this morning.");
    const cr = parseVtt(SAMPLE.replace(/\n/g, "\r"));
    expect(cr).toHaveLength(3);
  });

  it("strips WebVTT inline markup but keeps the words", () => {
    const cues = parseVtt(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Pastor>Grace <i>and</i> peace.\n"
    );
    expect(cues[0].text).toBe("Grace and peace.");
  });

  it("joins multi-line cue text into one line", () => {
    const cues = parseVtt(
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfirst line\nsecond line\n"
    );
    expect(cues[0].text).toBe("first line second line");
  });

  // ".1" is a tenth of a second, not a millisecond. Parsing it naively makes
  // every short-form timestamp 100x too early.
  it("pads a short millisecond field rather than misreading it", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.1 --> 00:00:02.5\nhi\n");
    expect(cues[0].start).toBeCloseTo(1.1);
    expect(cues[0].end).toBeCloseTo(2.5);
  });

  it("accepts a comma as the millisecond separator", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nhi\n");
    expect(cues[0].start).toBe(1);
  });

  it("accepts and ignores trailing cue settings", () => {
    const cues = parseVtt(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:50%\nhi\n"
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("hi");
  });

  it("skips a timing line with no text", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n");
    expect(cues).toEqual([]);
  });

  // Malformed rather than throwing: no transcript is a fine outcome, a broken
  // watch page is not.
  it("returns [] for junk instead of throwing", () => {
    for (const junk of ["", "not a vtt file at all", null, undefined, 42, {}, []]) {
      expect(parseVtt(junk)).toEqual([]);
    }
  });

  it("keeps a cue whose end precedes its start, anchored at its start", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:09.000 --> 00:00:02.000\nbackwards\n");
    expect(cues[0].start).toBe(9);
    expect(cues[0].end).toBe(9);
  });

  it("stops at MAX_CUES rather than holding an unbounded file", () => {
    const many =
      "WEBVTT\n\n" +
      Array.from(
        { length: MAX_CUES + 50 },
        (_, i) => `00:00:${String(i % 60).padStart(2, "0")}.000 --> 00:00:59.000\nline ${i}\n`
      ).join("\n");
    expect(parseVtt(many).length).toBe(MAX_CUES);
  });
});

describe("findCues", () => {
  const cues = parseVtt(SAMPLE);

  it("finds a cue regardless of case", () => {
    expect(findCues(cues, "PHILIPPIANS")).toHaveLength(1);
    expect(findCues(cues, "philippians")[0].text).toContain("Philippians");
  });

  it("carries the index so a caller can render position", () => {
    expect(findCues(cues, "Philippians")[0].index).toBe(1);
  });

  // Punctuation-insensitive, but apostrophes and hyphens need OPPOSITE
  // handling and a single rule gets one of them wrong. Both pinned.
  it("drops an apostrophe so \"christs\" matches \"Christ's\"", () => {
    const punct = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nChrist's own word.\n");
    expect(findCues(punct, "christs own")).toHaveLength(1);
    // And the typed-apostrophe form still matches.
    expect(findCues(punct, "christ's own")).toHaveLength(1);
    // A curly apostrophe is what a real transcript will contain.
    const curly = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nChrist\u2019s own word.\n");
    expect(findCues(curly, "christs")).toHaveLength(1);
  });

  it("spaces a hyphen so \"end of line\" matches \"end-of-line\"", () => {
    const hyphen = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nthe end-of-line marker\n");
    expect(findCues(hyphen, "end of line")).toHaveLength(1);
  });

  it("matches nothing for a blank query rather than everything", () => {
    for (const blank of ["", "   ", null, undefined, "!!!"]) {
      expect(findCues(cues, blank)).toEqual([]);
    }
  });
});

describe("transcriptMatches", () => {
  const cues = parseVtt(SAMPLE);

  it("is a yes/no over the whole transcript", () => {
    expect(transcriptMatches(cues, "Amen")).toBe(true);
    expect(transcriptMatches(cues, "kangaroo")).toBe(false);
  });

  // The phrase spans two cues, so a per-cue check would miss it. Library
  // search joins first for exactly this reason.
  it("matches a phrase that spans a cue boundary", () => {
    expect(transcriptMatches(cues, "morning Let us turn")).toBe(true);
  });

  it("is false for a blank query and for junk input", () => {
    expect(transcriptMatches(cues, "")).toBe(false);
    expect(transcriptMatches(null, "Amen")).toBe(false);
  });
});

describe("transcriptText", () => {
  it("joins every cue into one block", () => {
    expect(transcriptText(parseVtt(SAMPLE))).toContain(
      "Welcome to the service this morning. Let us turn"
    );
  });

  it("survives junk", () => {
    expect(transcriptText(null)).toBe("");
    expect(transcriptText([{}, { text: "" }])).toBe("");
  });
});

describe("cueAt", () => {
  const cues = parseVtt(SAMPLE);

  it("finds the cue playing at a moment", () => {
    expect(cueAt(cues, 2)?.text).toContain("Welcome");
    expect(cueAt(cues, 5)?.text).toContain("Philippians");
  });

  // Half-open interval: the end of one cue belongs to the next, not to both.
  it("treats a cue as [start, end)", () => {
    expect(cueAt(cues, 1)?.text).toContain("Welcome");
    expect(cueAt(cues, 4)).toBeNull();
  });

  it("returns null in a gap, before the start, and for junk", () => {
    expect(cueAt(cues, 0)).toBeNull();
    expect(cueAt(cues, 99999)).toBeNull();
    expect(cueAt(cues, NaN)).toBeNull();
    expect(cueAt(null, 2)).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("matches the shape lib/chapters.js renders", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(7)).toBe("0:07");
    expect(formatTimestamp(247)).toBe("4:07");
    expect(formatTimestamp(3847)).toBe("1:04:07");
  });

  it("floors fractions and clamps junk to 0:00", () => {
    expect(formatTimestamp(9.87)).toBe("0:09");
    expect(formatTimestamp(-5)).toBe("0:00");
    expect(formatTimestamp(NaN)).toBe("0:00");
    expect(formatTimestamp("nope")).toBe("0:00");
  });
});

// Mirrors matchingNoteGuids in lib/notes.js — pages/api/videos.js unions the
// two into one search, so they must agree on shape.
describe("matchingTranscriptGuids", () => {
  const map = {
    "vid-b": "let us turn together to the book of Philippians",
    "vid-a": "welcome to the service this morning",
    "vid-c": "nothing relevant here",
  };

  it("returns the guids whose transcript contains the query", () => {
    expect(matchingTranscriptGuids(map, "Philippians")).toEqual(["vid-b"]);
  });

  it("sorts, so the union order does not depend on hash iteration order", () => {
    expect(matchingTranscriptGuids(map, "the")).toEqual(["vid-a", "vid-b"]);
  });

  it("is case- and punctuation-insensitive like the in-video search", () => {
    expect(matchingTranscriptGuids({ x: "Christ's own word" }, "christs")).toEqual(["x"]);
  });

  it("returns [] for a blank query rather than every guid", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(matchingTranscriptGuids(map, blank)).toEqual([]);
    }
  });

  it("survives a null map", () => {
    expect(matchingTranscriptGuids(null, "anything")).toEqual([]);
  });
});

// --- CodeQL: incomplete multi-character sanitization (lib/captions.js) -----
//
// A single pass of /<[^>]*>/g cannot match an UNTERMINATED tag, so '<script'
// survived it whole. Not reachable as an injection here — the transcript only
// ever renders through React — but a sanitizer that leaves the exact string
// it exists to remove is one future consumer away from being a real bug.
describe('cue text carries no tag-shaped string out', () => {
  const cueFor = (text) =>
    parseVtt(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`)[0]?.text ?? '';

  it('strips an unterminated tag rather than passing it through', () => {
    // The BRACKET goes, the word stays. 'script' as plain text is harmless;
    // '<script' is the thing that must never survive.
    expect(cueFor('<script')).toBe('script');
    expect(cueFor('hello <script alert')).toBe('hello script alert');
  });

  it('leaves no angle bracket at all, whatever the input', () => {
    for (const nasty of [
      '<script',
      '<<script>>',
      '<scr<x>ipt>',
      '<img src=x onerror=1',
      'a < b and c > d',
      '<<<>>>',
    ]) {
      const out = cueFor(nasty);
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
    }
  });

  it('still strips the WebVTT markup it was written for', () => {
    expect(cueFor('<v Speaker>Hello <i>there</i>')).toBe('Hello there');
    expect(cueFor('<00:00:01.500>karaoke')).toBe('karaoke');
  });

  it('keeps ordinary speech intact', () => {
    expect(cueFor('the cost was under 5 dollars')).toBe('the cost was under 5 dollars');
  });
});

// --- Languages -------------------------------------------------------------
//
// A video can carry a transcript in several languages. The rule that matters
// is that a request for one we do not have is never quietly answered with a
// different one: a viewer who picks Spanish and reads English concludes the
// translation is WRONG, which is worse than being told there isn't one.
describe('normalizeLanguages', () => {
  it('cleans, dedupes and sorts', () => {
    expect(normalizeLanguages([' EN ', 'en', 'de', 'pt-BR'])).toEqual(['de', 'en', 'pt-br']);
  });

  it('drops anything that is not a language code', () => {
    expect(normalizeLanguages(['en', '', '  ', 'x', 'a-very-long-code-indeed', null])).toEqual([
      'en',
    ]);
  });

  it('survives junk input', () => {
    expect(normalizeLanguages(null)).toEqual([]);
    expect(normalizeLanguages('en')).toEqual([]);
  });
});

describe('pickLanguage', () => {
  const available = ['de', 'en', 'es'];

  it('serves what was asked for when it exists', () => {
    expect(pickLanguage(available, 'es')).toBe('es');
    expect(pickLanguage(available, ' ES ')).toBe('es');
  });

  it("falls back to the video's own default, not blindly to English", () => {
    // The default is the track that was ingested first; a video transcribed
    // in German should open in German.
    expect(pickLanguage(available, null, 'de')).toBe('de');
  });

  it('falls back to English when there is no usable default', () => {
    expect(pickLanguage(available, null, null)).toBe('en');
    expect(pickLanguage(available, null, 'fr')).toBe('en');
  });

  it('falls back to whatever exists when there is no English either', () => {
    expect(pickLanguage(['de', 'es'], null, null)).toBe('de');
  });

  it('does NOT serve a language that was asked for but is absent', () => {
    // It picks a fallback — and languageMissing is what tells the caller to
    // say so rather than pretending the request was honoured.
    expect(pickLanguage(available, 'fr')).toBe('en');
    expect(languageMissing(available, 'fr')).toBe(true);
  });

  it('returns null when the video has no transcript at all', () => {
    expect(pickLanguage([], 'en')).toBeNull();
    expect(pickLanguage(null, null)).toBeNull();
  });
});

describe('languageMissing', () => {
  it('is false when nothing was asked for', () => {
    // No request cannot be an unmet one.
    expect(languageMissing(['en'], null)).toBe(false);
    expect(languageMissing(['en'], '')).toBe(false);
  });

  it('is false when the request was met', () => {
    expect(languageMissing(['en', 'de'], 'de')).toBe(false);
  });

  it('is true when the request cannot be met', () => {
    expect(languageMissing(['en'], 'de')).toBe(true);
    expect(languageMissing([], 'en')).toBe(true);
  });
});
