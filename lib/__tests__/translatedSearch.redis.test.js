// Searching every transcript language, against a REAL redis-server: the
// translation text lib/captionsStore.js writes, the script that searches it
// inside Redis, and the cleanup that must remove it again.
//
// The script is the unit under test — it is what decides 'did this video say
// that, in any language' — so a mock that echoed back ids would prove nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalScript, shouldSkip, startRedis } from './helpers/localRedis';

let server;
let r;
// What the script itself returned, before the store turns it into a Set — so
// a test can see what actually crosses the network.
let lastEvalReply = null;

function toObject(flat) {
  if (!flat || !flat.length) return null;
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

// The subset of the Upstash client the transcript store uses, in its shapes.
// Values are stored as the client would send them: objects as JSON.
const toWire = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const adapter = {
  hset: (key, obj) => r.call('HSET', key, ...Object.entries(obj).flatMap(([f, v]) => [f, toWire(v)])),
  hget: async (key, field) => {
    const raw = await r.call('HGET', key, field);
    try {
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return raw;
    }
  },
  hgetall: async (key) => toObject(await r.call('HGETALL', key)),
  hdel: (key, ...fields) => r.call('HDEL', key, ...fields),
  hkeys: (key) => r.call('HKEYS', key),
  eval: async (script, keys, args) => {
    lastEvalReply = await evalScript(r, script, keys, args);
    return lastEvalReply;
  },
};

vi.mock('../redis', () => ({
  redis: adapter,
  k: (key) => `pvp:${key}`,
}));

const store = await import('../captionsStore');

const cues = (...lines) => lines.map((text, i) => ({ start: i, end: i + 1, text }));

async function transcribe(id, byLanguage) {
  const [first, ...rest] = Object.keys(byLanguage);
  await store.setTranscript(id, cues(...byLanguage[first]));
  for (const lang of rest) await store.setTranscriptLanguage(id, lang, cues(...byLanguage[lang]));
  await store.setTranscriptLanguages(id, first, Object.keys(byLanguage));
}

describe.skipIf(shouldSkip)('searching translations on a real redis-server', () => {
  beforeAll(async () => {
    server = await startRedis();
    r = server.client;
  });
  afterAll(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    await r.call('FLUSHALL');
  });

  it('finds a video by a phrase said only in its Spanish translation', async () => {
    await transcribe('vid-1', {
      en: ['Where is the lost sheep?'],
      es: ['¿Dónde está la oveja perdida?'],
    });
    await transcribe('vid-2', { en: ['The harbour at dawn.'], es: ['El puerto al amanecer.'] });
    expect((await store.matchingTranslatedGuids('oveja perdida'))).toEqual(['vid-1']);
  });

  it('matches the way the default track does — case, accents kept, punctuation ignored', async () => {
    await transcribe('vid-1', { en: ['Hello'], es: ['¿Dónde ESTÁ la oveja?'] });
    // Upper case, the question marks and the comma all fall away; the accent
    // is part of the word and stays.
    expect((await store.matchingTranslatedGuids('DÓNDE, está'))).toEqual(['vid-1']);
    expect((await store.matchingTranslatedGuids('donde esta'))).toEqual([]);
  });

  it('returns each video once, however many of its translations match', async () => {
    await transcribe('vid-1', { en: ['Hello'], es: ['amen amen'], pt: ['amen'] });
    expect((await store.matchingTranslatedGuids('amen'))).toEqual(['vid-1']);
    // Once in the REPLY, not just after the Set: the reply is what a library
    // of many-language sermons would otherwise multiply.
    expect(lastEvalReply).toEqual(['vid-1']);
  });

  it('does not search the DEFAULT track here — the route already has it', async () => {
    await transcribe('vid-1', { en: ['the lost sheep'], es: ['la oveja'] });
    expect((await store.matchingTranslatedGuids('lost sheep'))).toEqual([]);
  });

  it('finds nothing for an empty or punctuation-only query', async () => {
    await transcribe('vid-1', { en: ['Hello'], es: ['la oveja'] });
    expect(await store.matchingTranslatedGuids('')).toEqual([]);
    expect(await store.matchingTranslatedGuids('?!')).toEqual([]);
  });

  it("forgets a video's translations when its transcript is cleared", async () => {
    await transcribe('vid-1', { en: ['Hello'], es: ['la oveja perdida'] });
    await store.clearTranscript('vid-1');
    expect((await store.matchingTranslatedGuids('oveja'))).toEqual([]);
    expect(await r.call('HLEN', 'pvp:transcripts_alt')).toBe(0);
    expect(await r.call('HLEN', 'pvp:transcript_text_alt')).toBe(0);
  });

});
