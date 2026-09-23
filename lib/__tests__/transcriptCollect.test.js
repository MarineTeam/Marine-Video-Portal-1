// Collecting a finished transcription without the admin's second click.
//
// This runs on a request an admin made for something else, so the rule that
// matters most is that it can never make that request fail — and just behind
// it, that a marker is only cleared when the work is genuinely done or
// genuinely hopeless. Clearing early loses a transcript already paid for,
// with nothing left to say it is missing.
//
// Two things here are specific to this repo, and are why the file is not a
// copy of the sibling's: getVideoById answers NULL for a deleted video rather
// than throwing, and setTranscript REPORTS failure rather than throwing. Both
// have to be read, or a marker gets cleared on work that did not happen.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pending = {};
let videos = {};
let vttByKey = {};
let stored = {};
let alt = {};
let index = {};
let getVideoThrows = false;
let storeOk = true;

vi.mock('../bunny', () => ({
  getVideoById: async (videoId) => {
    if (getVideoThrows) throw new Error('bunny down');
    return videos[videoId] || null;
  },
  fetchCaptionVtt: async (videoId, lang) => vttByKey[`${videoId}:${lang}`] || '',
}));
vi.mock('../captionsStore', () => ({
  getTranscribePending: async () => pending,
  clearTranscribePending: async (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) delete pending[id];
  },
  setTranscript: async (videoId, cues) => {
    if (!storeOk) return { ok: false, error: 'redis down' };
    stored[videoId] = cues;
    return { ok: true, cues: cues.length };
  },
  setTranscriptLanguage: async (videoId, lang, cues) => {
    alt[`${videoId}:${lang}`] = cues;
    return { ok: true, cues: cues.length };
  },
  setTranscriptLanguages: async (videoId, defaultLang, langs) => {
    index[videoId] = { default: defaultLang, all: langs };
  },
}));

const { collectFinishedTranscripts } = await import('../transcriptCollect');

const OLD = Date.now() - 10 * 60 * 1000;
const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n';

beforeEach(() => {
  pending = {};
  videos = {};
  vttByKey = {};
  stored = {};
  alt = {};
  index = {};
  getVideoThrows = false;
  storeOk = true;
});

describe('collecting', () => {
  beforeEach(() => {
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [{ srclang: 'en' }] };
    vttByKey['vid-1:en'] = vtt;
  });

  it('stores the transcript and clears the marker', async () => {
    const result = await collectFinishedTranscripts();
    expect(stored['vid-1']).toHaveLength(1);
    expect(pending['vid-1']).toBeUndefined();
    expect(result.collected).toEqual([
      { videoId: 'vid-1', language: 'en', cues: 1, languages: ['en'] },
    ]);
  });

  it('prefers English as the DEFAULT when bunny produced several', async () => {
    videos['vid-1'].captions = [{ srclang: 'de' }, { srclang: 'en' }];
    vttByKey['vid-1:de'] = vtt;
    expect((await collectFinishedTranscripts()).collected[0].language).toBe('en');
  });

  it('stores EVERY track, not just the default', async () => {
    // Translation is billed per language. A portal that paid for German and
    // got only English back has paid for nothing.
    videos['vid-1'].captions = [{ srclang: 'en' }, { srclang: 'de' }];
    vttByKey['vid-1:de'] = vtt;
    const result = await collectFinishedTranscripts();
    // Copy before sorting: .sort() mutates, and this is the same array the
    // store was handed.
    expect([...result.collected[0].languages].sort()).toEqual(['de', 'en']);
    expect(alt['vid-1:de']).toHaveLength(1);
    expect(index['vid-1']).toEqual({ default: 'en', all: ['en', 'de'] });
  });

  it('stores NOTHING when the default track does not parse', async () => {
    // A picker over an empty transcript is worse than no picker: the video
    // would look transcribed and read as blank.
    videos['vid-1'].captions = [{ srclang: 'en' }, { srclang: 'de' }];
    vttByKey['vid-1:en'] = 'WEBVTT\n\n';
    vttByKey['vid-1:de'] = vtt;
    await collectFinishedTranscripts();
    expect(stored['vid-1']).toBeUndefined();
    expect(alt['vid-1:de']).toBeUndefined();
    expect(pending['vid-1']).toBe(OLD);
  });
});

describe('leaving a marker alone', () => {
  it('keeps waiting when bunny has produced no captions yet', async () => {
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [] };
    await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
  });

  it('keeps waiting for a video bunny answers NULL for, QUIETLY', async () => {
    // A deleted video is the likeliest reason a marker never resolves, and it
    // is an expected path, not a fault: the marker is left to age out and
    // nothing is logged. Without the explicit null check the behaviour is the
    // same — reading .captions on null throws into the surrounding catch —
    // but every admin page load then logs an error for a video that is simply
    // gone. That difference is what this asserts, because asserting only the
    // marker would pass either way.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      pending = { 'vid-1': OLD };
      videos = {};
      const result = await collectFinishedTranscripts();
      expect(pending['vid-1']).toBe(OLD);
      expect(result.collected).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps waiting when the STORE reports a failed write', async () => {
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [{ srclang: 'en' }] };
    vttByKey['vid-1:en'] = vtt;
    storeOk = false;
    await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
    expect(stored['vid-1']).toBeUndefined();
  });

  it('keeps waiting when bunny throws, so a blip is retried', async () => {
    pending = { 'vid-1': OLD };
    getVideoThrows = true;
    await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
  });
});

describe('never breaking the request it rides on', () => {
  it('does not throw when bunny is down', async () => {
    pending = { 'vid-1': OLD };
    getVideoThrows = true;
    await expect(collectFinishedTranscripts()).resolves.toBeTruthy();
  });

  it('does nothing at all when nothing is pending', async () => {
    expect(await collectFinishedTranscripts()).toEqual({ collected: [], expired: [] });
  });
});

describe('giving up', () => {
  it('drops a marker past the deadline without fetching it', async () => {
    pending = { ancient: Date.now() - 48 * 60 * 60 * 1000 };
    const result = await collectFinishedTranscripts();
    expect(result.expired).toEqual(['ancient']);
    expect(pending.ancient).toBeUndefined();
  });
});
