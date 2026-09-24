// GET /api/cron/transcripts — the scheduled transcript collector, and
// lib/cronAuth.js, the only thing guarding it.
//
// The route has no session and this repo has no middleware, so the secret check
// IS the access control. The tests below are mostly about refusing: no secret
// configured, a short one, a wrong one, a missing header, the wrong method —
// each must answer without the collector ever running.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

async function callRoute(handler, { method = 'GET', headers = {} } = {}) {
  const res = mockRes();
  await handler({ method, headers, query: {}, body: {}, url: '/' }, res);
  return res;
}

const collect = vi.fn();
const audit = [];
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: (...a) => collect(...a) }));
vi.mock('../audit', () => ({ logAudit: async (...a) => audit.push(a) }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/cron/transcripts')).default;
const { cronSecret, isCronAuthorized, MIN_CRON_SECRET_LENGTH } = await import('../cronAuth');
const { MAX_COLLECT_PER_SCHEDULED_RUN } = await import('../transcribeQueue');

const SECRET = 's3cret-value-long-enough-0123';
const bearer = (s = SECRET) => ({ authorization: `Bearer ${s}` });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  collect.mockReset().mockResolvedValue({ collected: [], expired: [], busy: false });
  audit.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('cronAuth', () => {
  it('accepts exactly `Bearer <secret>`', () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ['a wrong secret', `Bearer ${SECRET}x`],
    ['the secret without Bearer', SECRET],
    ['a different scheme', `Basic ${SECRET}`],
    ['an empty header', ''],
    ['no header', undefined],
    ['a repeated header', [`Bearer ${SECRET}`]],
  ])('refuses %s', (_why, header) => {
    expect(isCronAuthorized(header, SECRET)).toBe(false);
  });

  it('refuses everything when there is no secret, even an empty bearer', () => {
    expect(isCronAuthorized('Bearer ', '')).toBe(false);
    expect(isCronAuthorized('Bearer null', null)).toBe(false);
  });

  it('treats a missing or short secret as not configured', () => {
    expect(cronSecret({})).toBeNull();
    expect(cronSecret({ CRON_SECRET: 'x'.repeat(MIN_CRON_SECRET_LENGTH - 1) })).toBeNull();
    expect(cronSecret({ CRON_SECRET: SECRET })).toBe(SECRET);
    expect(cronSecret({ CRON_SECRET: ` ${SECRET}\n` })).toBe(SECRET);
    expect(cronSecret({ CRON_SECRET: '   ' })).toBeNull();
  });
});

describe('GET /api/cron/transcripts — refusing', () => {
  it('does not exist until CRON_SECRET is set', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await callRoute(route, { headers: bearer('') });
    expect(res.statusCode).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it('does not exist with a secret too short to trust', async () => {
    vi.stubEnv('CRON_SECRET', 'short');
    const res = await callRoute(route, { headers: bearer('short') });
    expect(res.statusCode).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it.each([
    ['no Authorization header', {}],
    ['a wrong secret', bearer('not-the-secret-at-all-000')],
  ])('401s with %s, collecting nothing', async (_why, headers) => {
    const res = await callRoute(route, { headers });
    expect(res.statusCode).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it('405s anything but GET, collecting nothing', async () => {
    const res = await callRoute(route, { method: 'POST', headers: bearer() });
    expect(res.statusCode).toBe(405);
    expect(collect).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/transcripts — running', () => {
  it('collects with the scheduled-run cap and audits each video', async () => {
    collect.mockResolvedValue({
      collected: [
        { videoId: 'v1', language: 'en', cues: 40 },
        { videoId: 'v2', language: 'es', cues: 12 },
      ],
      expired: ['old'],
      busy: false,
    });
    const res = await callRoute(route, { headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(collect).toHaveBeenCalledWith({ limit: MAX_COLLECT_PER_SCHEDULED_RUN });
    expect(res.body).toEqual({ ok: true, collected: 2, expired: 1, busy: false });
    expect(audit.map(([actor, action, detail]) => [actor, action, detail.split(' ')[0]])).toEqual([
      ['scheduled job', 'video.transcript_ingest', 'v1'],
      ['scheduled job', 'video.transcript_ingest', 'v2'],
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports a run skipped because another held the lock', async () => {
    collect.mockResolvedValue({ collected: [], expired: [], busy: true });
    const res = await callRoute(route, { headers: bearer() });
    expect(res.body).toEqual({ ok: true, collected: 0, expired: 0, busy: true });
  });

  it('500s when collection throws, so the cron log shows a failure', async () => {
    collect.mockRejectedValue(new Error('redis down'));
    const res = await callRoute(route, { headers: bearer() });
    expect(res.statusCode).toBe(500);
  });
});

describe('no middleware stands in front of scheduled jobs', () => {
  // This repo has no middleware today, so nothing but the secret decides who
  // reaches the route. If one is ever added (for sessions or geo), it must
  // leave /api/cron/* alone: Vercel's cron runner has no session and its
  // requests may carry no country.
  it('either there is no middleware, or its matcher skips /api/cron/*', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../..');
    const file = ['middleware.js', 'middleware.ts', 'proxy.js', 'proxy.ts']
      .map((name) => path.join(root, name))
      .find((p) => fs.existsSync(p));
    if (!file) return;
    const { config } = await import(file);
    const matchers = [].concat(config?.matcher || ['/(.*)']);
    for (const m of matchers) {
      expect(new RegExp(`^${m}$`).test('/api/cron/transcripts'), m).toBe(false);
    }
  });
});
