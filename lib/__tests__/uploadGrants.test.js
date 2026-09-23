import { describe, it, expect } from 'vitest';
import { MAX_UPLOAD_GROUPS, planUploadGrants } from '../uploadGrants';

// Decided before the bunny.net video exists, so every refusal here is one that
// never leaves an orphan video behind.
describe('planUploadGrants', () => {
  const known = ['g1', 'g2', 'g3'];

  it('grants nothing when nothing was ticked — an ordinary upload is unchanged', () => {
    expect(planUploadGrants(undefined, known)).toEqual({ ok: true, groupIds: [] });
    expect(planUploadGrants(null, known)).toEqual({ ok: true, groupIds: [] });
    expect(planUploadGrants([], known)).toEqual({ ok: true, groupIds: [] });
  });

  it('keeps the ticked groups, trimmed and de-duplicated', () => {
    expect(planUploadGrants(['g1', ' g2 ', 'g1'], known)).toEqual({ ok: true, groupIds: ['g1', 'g2'] });
  });

  it('refuses anything that is not a list of strings', () => {
    expect(planUploadGrants('g1', known)).toMatchObject({ ok: false, status: 400 });
    expect(planUploadGrants([1, 2], known)).toMatchObject({ ok: false, status: 400 });
    expect(planUploadGrants({ 0: 'g1' }, known)).toMatchObject({ ok: false, status: 400 });
  });

  // Quietly granting fewer groups than the admin chose is how a video ends up
  // invisible to the people it was uploaded for.
  it('REFUSES a group that no longer exists rather than skipping it', () => {
    const plan = planUploadGrants(['g1', 'deleted'], known);
    expect(plan).toMatchObject({ ok: false, status: 400 });
    expect(plan.error).toMatch(/no longer exist/);
  });

  it('caps how many groups one upload can name', () => {
    const many = Array.from({ length: MAX_UPLOAD_GROUPS + 1 }, (_, i) => `g${i}`);
    expect(planUploadGrants(many, many)).toMatchObject({ ok: false, status: 400 });
    expect(planUploadGrants(many.slice(0, MAX_UPLOAD_GROUPS), many)).toMatchObject({ ok: true });
  });
});
