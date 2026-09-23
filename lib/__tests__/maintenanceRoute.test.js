import { describe, it, expect, beforeEach, vi } from 'vitest';

// pages/api/admin/maintenance.js — the rating recount's place in it.
//
// The per-viewer sweep deletes a removed viewer's whole ratings hash, and the
// counters cannot know. So the recount must run AFTER the sweep (run it
// beside the sweep and it can count votes that are about to be deleted), and
// its failure must not cost the admin the result of sweeps that already ran.

const state = vi.hoisted(() => ({ order: [], recountThrows: false, auth: null }));

vi.mock('../roles', () => ({
  requireCapability: async (req, res, cap) => {
    state.cap = cap;
    if (!state.auth) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return state.auth;
  },
}));
vi.mock('../audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('../shareBundle', () => ({
  sweepStaleBundles: async () => ({ removed: 0 }),
  reapActiveShares: async () => ({ removed: 0 }),
}));
vi.mock('../maintenance', () => ({
  sweepOrphanedProgress: async () => {
    await new Promise((r) => setTimeout(r, 5));
    state.order.push('sweep');
    return { scanned: 3, removed: 1 };
  },
}));
vi.mock('../ratingsStore', () => ({
  recountRatings: async () => {
    state.order.push('recount');
    if (state.recountThrows) throw new Error('redis down at pvp:ratings:someone@example.com');
    return { viewers: 2, votes: 5, fields: 3 };
  },
}));
vi.mock('../monitor', () => ({ withMonitorApi: (handler) => handler }));

const route = (await import('../../pages/api/admin/maintenance')).default;
const { logAudit } = await import('../audit');

async function call(method = 'POST') {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  await route({ method, body: {}, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  state.order = [];
  state.recountThrows = false;
  state.auth = { email: 'admin@example.com', role: 'admin' };
  logAudit.mockClear();
});

describe('maintenance and the rating recount', () => {
  it('recounts only after the per-viewer sweep has finished', async () => {
    const res = await call();
    expect(state.order).toEqual(['sweep', 'recount']);
    expect(res.body.ratings).toEqual({ viewers: 2, votes: 5, fields: 3 });
  });

  it('audits the recount', async () => {
    await call();
    expect(logAudit).toHaveBeenCalledWith('admin@example.com', 'ratings.recount', expect.stringContaining('5 vote(s)'));
  });

  it('still reports the sweeps when the recount fails, without echoing the error', async () => {
    state.recountThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.progress).toEqual({ scanned: 3, removed: 1 });
    expect(res.body.ratings).toEqual({ error: 'Could not recount ratings' });
    expect(JSON.stringify(res.body)).not.toContain('someone@example.com');
    expect(logAudit).not.toHaveBeenCalledWith('admin@example.com', 'ratings.recount', expect.anything());
  });

  it('runs nothing without settings:manage', async () => {
    state.auth = null;
    const res = await call();
    expect(state.cap).toBe('settings:manage');
    expect(res.statusCode).toBe(403);
    expect(state.order).toEqual([]);
  });
});
