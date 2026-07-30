import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// Each test imports fresh so module-load-time reads of process.env (and
// lib/bunny.js's capture of globalThis.fetch) pick up that test's setup.
beforeEach(() => {
  vi.resetModules();
});

describe('monitorEnabled', () => {
  // The panel once rendered against a server that wasn't instrumented at all,
  // sitting at a frozen zero, because the flag was matched with a strict
  // === 'true'. A value pasted into Vercel arrives as 'true ' or 'True' easily,
  // and this repo has already lost time to invisible whitespace in env vars.
  it('accepts truthy spellings, surrounding whitespace and casing', async () => {
    for (const raw of ['true', 'true ', ' true', 'True', 'TRUE', '1', 'on', 'yes', ' YES ']) {
      process.env.QUERY_MONITOR_ENABLED = raw;
      vi.resetModules();
      const { monitorEnabled } = await import('../monitor');
      expect(monitorEnabled(), `expected ${JSON.stringify(raw)} to enable`).toBe(true);
    }
  });

  it('stays off when unset or falsey', async () => {
    for (const raw of [undefined, '', ' ', 'false', 'off', '0', 'no']) {
      if (raw === undefined) delete process.env.QUERY_MONITOR_ENABLED;
      else process.env.QUERY_MONITOR_ENABLED = raw;
      vi.resetModules();
      const { monitorEnabled } = await import('../monitor');
      expect(monitorEnabled(), `expected ${JSON.stringify(raw)} to stay off`).toBe(false);
    }
  });
});

describe('withMonitorPage', () => {
  it('attributes redis queries and external calls to the request', async () => {
    process.env.QUERY_MONITOR_ENABLED = 'true';
    const { withMonitorPage, recordQuery, recordExternal } = await import('../monitor');

    const gssp = withMonitorPage(async () => {
      recordQuery('get', 5);
      recordQuery('smembers', 7);
      recordExternal('bunny /videos', 40);
      return { props: { hello: 'world' } };
    });

    const { props } = await gssp({});
    expect(props.hello).toBe('world');
    expect(props._monitor.queryCount).toBe(2);
    expect(props._monitor.queryMs).toBe(12);
    expect(props._monitor.externalCount).toBe(1);
    expect(props._monitor.externalMs).toBe(40);
    expect(props._monitor.queries.map((q) => q.command)).toEqual(['get', 'smembers']);
  });

  it('is a no-op when disabled, and leaves redirects alone when enabled', async () => {
    process.env.QUERY_MONITOR_ENABLED = 'false';
    let mod = await import('../monitor');
    let out = await mod.withMonitorPage(async () => ({ props: {} }))({});
    expect(out.props._monitor).toBeUndefined();

    process.env.QUERY_MONITOR_ENABLED = 'true';
    vi.resetModules();
    mod = await import('../monitor');
    const redirect = { redirect: { destination: '/', permanent: false } };
    out = await mod.withMonitorPage(async () => redirect)({});
    expect(out).toEqual(redirect);
  });

  // Recording outside any monitored request must not throw — plenty of Redis and
  // Bunny calls happen from fire-and-forget paths with no surrounding context.
  it('ignores records made outside a request context', async () => {
    process.env.QUERY_MONITOR_ENABLED = 'true';
    const { recordQuery, recordExternal } = await import('../monitor');
    expect(() => recordQuery('get', 1)).not.toThrow();
    expect(() => recordExternal('bunny /videos', 1)).not.toThrow();
  });
});

describe('lib/bunny.js instrumentation', () => {
  // lib/bunny.js shadows `fetch` module-locally to time Bunny calls without
  // editing its call sites. These assertions pin the two things that must not
  // have changed: the byte-exact vendor signing contracts, and the fact that a
  // Bunny call still returns its response untouched.
  const LIB = '12345';
  const KEY = 'test-api-key';
  const TOKEN_KEY = 'token-key';
  const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    process.env.QUERY_MONITOR_ENABLED = 'true';
    process.env.BUNNY_LIBRARY_ID = LIB;
    process.env.BUNNY_API_KEY = KEY;
    process.env.BUNNY_TOKEN_AUTH_KEY = TOKEN_KEY;
  });

  it('keeps signTusUpload byte-exact, with expiry in seconds', async () => {
    const { signTusUpload } = await import('../bunny');
    const { signature, expires, libraryId } = signTusUpload(GUID, 3600);
    expect(signature).toBe(
      crypto.createHash('sha256').update(LIB + KEY + expires + GUID).digest('hex')
    );
    expect(libraryId).toBe(LIB);
    // seconds, not milliseconds — a 13-digit value here was a real 401 outage
    expect(String(expires)).toHaveLength(10);
  });

  it('keeps signVideoToken byte-exact and embeds with autoplay=false', async () => {
    const { signVideoToken, getEmbedUrl } = await import('../bunny');
    const { token, expires } = signVideoToken(GUID, 3600);
    expect(token).toBe(
      crypto.createHash('sha256').update(TOKEN_KEY + GUID + expires).digest('hex')
    );
    expect(getEmbedUrl(GUID).endsWith('autoplay=false')).toBe(true);
  });

  it('times a Bunny call as external and returns its payload unchanged', async () => {
    // Stubbed before importing lib/bunny, which captures globalThis.fetch at
    // module load — so no real network call is made.
    const stub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ guid: GUID, title: 'A' }] }),
    }));
    vi.stubGlobal('fetch', stub);

    const { withMonitorPage } = await import('../monitor');
    const { listVideos } = await import('../bunny');

    const gssp = withMonitorPage(async () => ({ props: { videos: await listVideos() } }));
    const { props } = await gssp({});

    expect(stub).toHaveBeenCalledTimes(1);
    expect(props.videos).toEqual([{ guid: GUID, title: 'A' }]);
    expect(props._monitor.externalCount).toBe(1);
    expect(props._monitor.external[0].label).toBe('bunny /videos');
  });
});
