import { afterEach, describe, expect, it, vi } from 'vitest';

// lib/bunny.js listVideosPage / isVideoId — the page reader lib/videoLibrary.js
// builds on, against a stubbed fetch (bunny.js captures globalThis.fetch at
// load, so the stub goes in before the import).
const calls = [];
let reply = { ok: true, status: 200, body: { items: [], totalItems: 0 } };
vi.stubGlobal('fetch', async (url, init) => {
  calls.push({ url: String(url), init });
  return { ok: reply.ok, status: reply.status, json: async () => reply.body };
});
process.env.BUNNY_LIBRARY_ID = '12345';
process.env.BUNNY_API_KEY = 'key';

const { listVideosPage, isVideoId } = await import('../bunny');

afterEach(() => {
  calls.length = 0;
  reply = { ok: true, status: 200, body: { items: [], totalItems: 0 } };
});

describe('listVideosPage', () => {
  it('asks for the page and size it is given, newest first', async () => {
    await listVideosPage({ page: 3, itemsPerPage: 100 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/library/12345/videos');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('itemsPerPage')).toBe('100');
    expect(url.searchParams.get('orderBy')).toBe('date');
  });

  it('returns the items AND bunny’s count of the whole library', async () => {
    reply.body = { items: [{ guid: 'a' }], totalItems: 250 };
    expect(await listVideosPage({ page: 1 })).toEqual({ items: [{ guid: 'a' }], totalItems: 250 });
  });

  it('reads a reply with no items or count as an empty page', async () => {
    reply.body = {};
    expect(await listVideosPage()).toEqual({ items: [], totalItems: 0 });
  });

  it('throws on a failed request rather than answer with an empty page', async () => {
    reply = { ok: false, status: 500, body: {} };
    await expect(listVideosPage()).rejects.toThrow('500');
  });
});

describe('isVideoId', () => {
  it('accepts a bunny guid and nothing else', () => {
    expect(isVideoId('0a1b2c3d-0000-4000-8000-000000000001')).toBe(true);
    expect(isVideoId('0A1B2C3D-0000-4000-8000-000000000001')).toBe(true);
    for (const bad of ['vid-1', '', '0a1b2c3d-0000-4000-8000-00000000000', null, 5, ['x'], '0a1b2c3d-0000-4000-8000-000000000001/..']) {
      expect(isVideoId(bad)).toBe(false);
    }
  });
});
