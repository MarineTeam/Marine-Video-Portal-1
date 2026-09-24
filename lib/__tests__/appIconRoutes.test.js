// The two app-icon routes: the public one that serves it, and the admin one
// that sets it — plus the store's write order, which is what stops a reader
// ever seeing a version whose images are not all there yet.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hash = {};
const ops = [];
let versionSeenDuringImageWrite = false;
let readThrows = false;
let access = null;

vi.mock('../redis', () => ({
  k: (name) => `pvp:${name}`,
  redis: {
    hget: async (key, field) => {
      if (readThrows) throw new Error('redis down');
      return key === 'pvp:app_icon' ? hash[field] ?? null : null;
    },
    hset: async (key, obj) => {
      ops.push(['hset', ...Object.keys(obj)]);
      // What a concurrent reader would see at the moment an IMAGE is written.
      if (Object.keys(obj).some((f) => f.startsWith('s'))) {
        versionSeenDuringImageWrite ||= Boolean(hash.version);
      }
      Object.assign(hash, obj);
      return 1;
    },
    hdel: async (key, ...fields) => {
      ops.push(['hdel', ...fields]);
      for (const f of fields) delete hash[f];
      return 1;
    },
    del: async () => {
      ops.push(['del']);
      for (const f of Object.keys(hash)) delete hash[f];
      return 1;
    },
  },
}));
vi.mock('../roles', () => ({
  requireCapability: async (req, res, cap) => {
    if (!access || !access.capabilities.includes(cap)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    // This repo's requireCapability returns { session, email, role }.
    return { session: {}, email: access.email, role: 'admin' };
  },
}));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const publicRoute = (await import('../../pages/api/app-icon/[size]')).default;
const adminRoute = (await import('../../pages/api/admin/app-icon')).default;
const CAP = { SETTINGS_MANAGE: 'settings:manage', VIDEOS_MANAGE: 'videos:manage' };

async function callRoute(handler, { method = 'GET', query = {}, body = {} } = {}) {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
    setHeader(n, v) { headers[String(n).toLowerCase()] = v; return res; },
    getHeader(n) { return headers[String(n).toLowerCase()]; },
    end(b) { if (b !== undefined) res.body = b; return res; },
  };
  await handler({ method, query, body, headers: {}, url: '/' }, res);
  return res;
}
const { ICON_SIZES } = await import('../appIcon');

function png(size) {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return bytes;
}
const icons = () => Object.fromEntries(ICON_SIZES.map((s) => [s, png(s).toString('base64')]));

beforeEach(() => {
  for (const f of Object.keys(hash)) delete hash[f];
  ops.length = 0;
  versionSeenDuringImageWrite = false;
  readThrows = false;
  access = { email: 'admin@example.com', capabilities: [CAP.SETTINGS_MANAGE] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/app-icon/[size]', () => {
  it('redirects to the built-in icon when none is set', async () => {
    const res = await callRoute(publicRoute, { query: { size: '512' } });
    expect(res.statusCode).toBe(302);
    expect(res.getHeader('location')).toBe('/icon-512.png');
  });

  it('falls back to the built-in icon when the store cannot be read', async () => {
    readThrows = true;
    const res = await callRoute(publicRoute, { query: { size: '180' } });
    expect(res.getHeader('location')).toBe('/apple-touch-icon.png');
  });

  it('serves the stored PNG as a PNG, with nothing a browser could reinterpret', async () => {
    await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    const res = await callRoute(publicRoute, { query: { size: '192' } });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toBe('image/png');
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
    expect(res.getHeader('content-security-policy')).toBe('default-src \'none\'');
    expect(Buffer.compare(res.body, png(192))).toBe(0);
  });

  it('caches the CURRENT version for a year, anything else briefly', async () => {
    const { body } = await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    const current = await callRoute(publicRoute, { query: { size: '512', v: body.version } });
    expect(current.getHeader('cache-control')).toMatch(/immutable/);
    const stale = await callRoute(publicRoute, { query: { size: '512', v: 'v000000000000' } });
    expect(stale.getHeader('cache-control')).toBe('public, max-age=300');
  });

  it('404s a size that does not exist', async () => {
    for (const size of ['64', '../../etc', ['512', '192']]) {
      expect((await callRoute(publicRoute, { query: { size } })).statusCode).toBe(404);
    }
  });
});

describe('PUT/DELETE /api/admin/app-icon', () => {
  it('requires SETTINGS_MANAGE', async () => {
    access = { email: 'm@example.com', capabilities: [CAP.VIDEOS_MANAGE] };
    const res = await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    expect(res.statusCode).toBe(403);
    expect(ops).toEqual([]);
  });

  it('refuses an invalid set and stores nothing', async () => {
    const bad = icons();
    bad[512] = Buffer.from('<svg/>').toString('base64');
    const res = await callRoute(adminRoute, { method: 'PUT', body: { icons: bad } });
    expect(res.statusCode).toBe(400);
    expect(ops).toEqual([]);
  });

  it('never shows a version while the images are being written — even over an old set', async () => {
    await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    versionSeenDuringImageWrite = false;
    // A second upload over the first: the OLD version must be gone before any
    // new image lands, or a reader would pair it with half-new images.
    await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    expect(versionSeenDuringImageWrite).toBe(false);
  });

  it('writes the version LAST, after every image, and returns it', async () => {
    const res = await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    expect(res.body.version).toMatch(/^v[0-9a-f]{12}$/);
    expect(ops[ops.length - 1]).toEqual(['hset', 'version']);
    expect(ops.filter(([op, f]) => op === 'hset' && f.startsWith('s'))).toHaveLength(3);
  });

  it('resets by clearing the version FIRST, then everything', async () => {
    await callRoute(adminRoute, { method: 'PUT', body: { icons: icons() } });
    ops.length = 0;
    const res = await callRoute(adminRoute, { method: 'DELETE' });
    expect(res.statusCode).toBe(200);
    expect(ops[0]).toEqual(['hdel', 'version']);
    const after = await callRoute(publicRoute, { query: { size: '512' } });
    expect(after.statusCode).toBe(302);
  });
});
