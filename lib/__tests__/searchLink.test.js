import { describe, expect, it } from 'vitest';
import { linkedQuery, MAX_LINKED_QUERY, passageSearchHref } from '../searchLink';

describe('linkedQuery / passageSearchHref', () => {
  it('takes a string from the URL, trimmed', () => {
    expect(linkedQuery('  Philippians 2  ')).toBe('Philippians 2');
  });

  it('refuses a repeated parameter rather than joining it', () => {
    expect(linkedQuery(['John 3', 'Mark 1'])).toBe('');
    expect(linkedQuery(undefined)).toBe('');
    expect(linkedQuery(42)).toBe('');
  });

  it('caps what a crafted URL can put in the search box', () => {
    expect(linkedQuery('x'.repeat(500))).toHaveLength(MAX_LINKED_QUERY);
  });

  it('builds a link that reads back to the same passage', () => {
    const href = passageSearchHref('Philippians 1:27–2:11');
    const q = new URL(href, 'https://x.test').searchParams.get('q');
    expect(linkedQuery(q)).toBe('Philippians 1:27–2:11');
  });
});
