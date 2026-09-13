import { describe, it, expect, beforeEach, vi } from 'vitest';

// The public watch page is the only route that serves a video without a
// session, so these tests exist to hold one line: NOTHING is reachable there
// unless an admin explicitly ticked that specific video public.

const state = vi.hoisted(() => ({
  sets: new Map(),
  hashes: new Map(),
  country: null,
  redisThrows: false,
}));

function members(key) {
  if (!state.sets.has(key)) state.sets.set(key, new Set());
  return state.sets.get(key);
}
function hash(key) {
  if (!state.hashes.has(key)) state.hashes.set(key, new Map());
  return state.hashes.get(key);
}

vi.mock('../redis', () => ({
  k: (key) => `pvp:${key}`,
  redis: {
    sismember: async (key, m) => {
      if (state.redisThrows) throw new Error('upstash is down');
      return members(key).has(m) ? 1 : 0;
    },
    smembers: async (key) => [...members(key)],
    sadd: async (key, ...m) => m.forEach((x) => members(key).add(x)),
    srem: async (key, ...m) => m.forEach((x) => members(key).delete(x)),
    hget: async (key, f) => hash(key).get(f) ?? null,
    hgetall: async (key) => Object.fromEntries(hash(key)),
    hset: async (key, obj) => Object.entries(obj).forEach(([f, v]) => hash(key).set(f, v)),
    hdel: async (key, f) => hash(key).delete(f),
    get: async () => null,
    set: async () => 'OK',
  },
}));

vi.mock('../bunny', () => ({
  listVideos: async () => [
    { guid: 'vid-public', title: 'Sunday Service', collectionId: '' },
    { guid: 'vid-private', title: 'Members Only', collectionId: '' },
  ],
  getEmbedUrl: (guid) => `https://iframe.mediadelivery.net/embed/0/${guid}?token=x&expires=1&autoplay=false`,
}));

const { resolvePublicVideo } = await import('../publicWatch');

const req = () => ({ headers: state.country ? { 'x-vercel-ip-country': state.country } : {} });
const load = async (id) => ({ props: await resolvePublicVideo(req(), id) });

beforeEach(() => {
  state.sets.clear();
  state.hashes.clear();
  state.country = null;
  state.redisThrows = false;
});

describe('public watch page', () => {
  it('serves a video an admin marked public', async () => {
    members('pvp:public_videos').add('vid-public');
    const { props } = await load('vid-public');
    expect(props.error).toBeUndefined();
    expect(props.title).toBe('Sunday Service');
    expect(props.embedUrl).toContain('token=');
  });

  // The core assertion of this file.
  it('refuses a video that was never marked public', async () => {
    const { props } = await load('vid-private');
    expect(props.error).toBeDefined();
    expect(props.embedUrl).toBeUndefined();
  });

  it('refuses when nothing at all is public', async () => {
    const { props } = await load('vid-public');
    expect(props.error).toBeDefined();
  });

  it('refuses an unknown id', async () => {
    members('pvp:public_videos').add('vid-public');
    const { props } = await load('no-such-video');
    expect(props.error).toBeDefined();
  });

  it('refuses an empty id', async () => {
    const { props } = await load('');
    expect(props.error).toBeDefined();
  });

  // Probing must not distinguish "private", "missing" and "out of window".
  it('gives the same message however it refuses', async () => {
    members('pvp:public_videos').add('vid-public');
    const cases = await Promise.all([load('vid-private'), load('no-such-video'), load('')]);
    const messages = new Set(cases.map((c) => c.props.error));
    expect(messages.size).toBe(1);
  });

  it('never leaks another video in props', async () => {
    members('pvp:public_videos').add('vid-public');
    const { props } = await load('vid-public');
    expect(JSON.stringify(props)).not.toContain('vid-private');
    expect(JSON.stringify(props)).not.toContain('Members Only');
  });

  describe('still honours the publish window', () => {
    const hour = 3600 * 1000;

    it('hides a public video scheduled for the future', async () => {
      members('pvp:public_videos').add('vid-public');
      hash('pvp:video_schedule').set(
        'vid-public',
        JSON.stringify({ publishAt: Date.now() + hour, expiresAt: null })
      );
      const { props } = await load('vid-public');
      expect(props.error).toBeDefined();
    });

    it('hides a public video whose window has closed', async () => {
      members('pvp:public_videos').add('vid-public');
      hash('pvp:video_schedule').set(
        'vid-public',
        JSON.stringify({ publishAt: null, expiresAt: Date.now() - hour })
      );
      const { props } = await load('vid-public');
      expect(props.error).toBeDefined();
    });

    it('serves one inside its window', async () => {
      members('pvp:public_videos').add('vid-public');
      hash('pvp:video_schedule').set(
        'vid-public',
        JSON.stringify({ publishAt: Date.now() - hour, expiresAt: Date.now() + hour })
      );
      const { props } = await load('vid-public');
      expect(props.error).toBeUndefined();
    });
  });

  // Inverted failure posture: everything else here fails open, this fails
  // closed. An Upstash blip must not publish the library to the internet.
  it('fails CLOSED when Redis is unreachable', async () => {
    members('pvp:public_videos').add('vid-public');
    state.redisThrows = true;
    const { props } = await load('vid-public');
    expect(props.error).toBeDefined();
    expect(props.embedUrl).toBeUndefined();
  });

  it('carries chapters and notes but no watermark', async () => {
    members('pvp:public_videos').add('vid-public');
    hash('pvp:video_meta').set(
      'vid-public',
      JSON.stringify({ notes: 'On Philippians', chapters: [{ seconds: 0, label: 'Worship' }] })
    );
    const { props } = await load('vid-public');
    expect(props.notes).toBe('On Philippians');
    expect(props.chapters).toHaveLength(1);
    expect(props.watermarkText).toBeUndefined();
  });
});
