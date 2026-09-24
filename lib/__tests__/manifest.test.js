// pages/api/manifest.js — which icons an install is offered.
import { describe, expect, it, vi } from 'vitest';

let version = null;
vi.mock('../brandingStore', () => ({ getSiteName: async () => 'Grace Chapel' }));
vi.mock('../appIconStore', () => ({
  getAppIconVersion: async () => {
    if (version === 'throw') throw new Error('redis down');
    return version;
  },
}));

const route = (await import('../../pages/api/manifest')).default;

async function manifest() {
  const out = {};
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    send(b) { out.body = JSON.parse(b); return res; },
    setHeader: () => res,
  };
  await route({ method: 'GET', query: {}, headers: {} }, res);
  return out.body;
}

describe('manifest icons', () => {
  it('offers the built-in icons when none is set', async () => {
    version = null;
    const body = await manifest();
    expect(body.icons.map((i) => i.src)).toEqual(['/icon-192.png', '/icon-512.png', '/icon-512.png', '/icon.svg']);
  });

  it('replaces ALL of them — the SVG and maskable too — with the admin-set icon', async () => {
    version = 'vabc123def456';
    const body = await manifest();
    expect(body.icons).toEqual([
      { src: '/api/app-icon/192?v=vabc123def456', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/api/app-icon/512?v=vabc123def456', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ]);
  });

  it('falls back to the built-in icons when the version cannot be read', async () => {
    version = 'throw';
    const body = await manifest();
    expect(body.icons[0].src).toBe('/icon-192.png');
    expect(body.name).toBe('Grace Chapel');
  });
});
