// Who may be put in a group.
//
// Membership decides what a viewer sees, and until this existed any address
// could be added — including one with no account. That leaves a row nothing
// reads and nothing cleans, and one that becomes REAL the day that address is
// approved: the person signs in and finds a library already narrowed by a
// group somebody typed them into months earlier.
//
// The refusals matter as much as the rule. An admin who pastes twelve
// addresses and is told "12 added" has no way to find the three typos until
// somebody reports seeing nothing.
import { describe, expect, it } from 'vitest';
import { planGroupAdditions } from '../groups';

const approved = new Set(['a@x.com', 'b@x.com']);

describe('planGroupAdditions', () => {
  it('accepts approved viewers', () => {
    const plan = planGroupAdditions(['a@x.com', 'b@x.com'], approved);
    expect(plan.eligible).toEqual(['a@x.com', 'b@x.com']);
    expect(plan.unknown).toEqual([]);
  });

  it('REFUSES an address that is not an approved viewer, and names it', () => {
    const plan = planGroupAdditions(['a@x.com', 'ghost@x.com'], approved);
    expect(plan.eligible).toEqual(['a@x.com']);
    expect(plan.unknown).toEqual(['ghost@x.com']);
  });

  it('separates an unusable address from an unapproved one', () => {
    // Two different mistakes with two different fixes: fix the typo, or
    // approve the person first.
    const plan = planGroupAdditions(['not an email', 'ghost@x.com'], approved);
    expect(plan.invalid).toEqual(['not an email']);
    expect(plan.unknown).toEqual(['ghost@x.com']);
    expect(plan.eligible).toEqual([]);
  });

  it('normalizes case and whitespace before checking', () => {
    // "A@X.com" is a@x.com. Checking the raw string would refuse a viewer who
    // is plainly approved.
    expect(planGroupAdditions([' A@X.com '], approved).eligible).toEqual(['a@x.com']);
  });

  it('dedupes, and ignores empty entries from a pasted list', () => {
    const plan = planGroupAdditions(['a@x.com', 'a@x.com', '', '   '], approved);
    expect(plan.eligible).toEqual(['a@x.com']);
    expect(plan.invalid).toEqual([]);
  });

  it('checks nothing when the approved set could not be read', () => {
    // A Redis blip must not refuse everybody. No set means "could not check",
    // which fails toward the behaviour that existed before this rule.
    const plan = planGroupAdditions(['ghost@x.com'], null);
    expect(plan.eligible).toEqual(['ghost@x.com']);
    expect(plan.unknown).toEqual([]);
  });

  it('handles junk input without throwing', () => {
    expect(planGroupAdditions()).toEqual({ eligible: [], unknown: [], invalid: [] });
    expect(planGroupAdditions('nope', approved).eligible).toEqual([]);
  });
});
