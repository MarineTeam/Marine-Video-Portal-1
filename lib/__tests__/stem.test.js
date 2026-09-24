// lib/stem.js — the conservative stemmer behind search.
//
// Two failure directions again, as with scripture references. MISSING a
// family costs a viewer a result; CONFLATING two words ("Peter" with "pet")
// makes the search look broken. The second list is as long as the first.
import { describe, expect, it } from 'vitest';
import { queryStems, stem, stemSet, stemsMatch, words } from '../stem';

describe('families that must collapse to one stem', () => {
  it.each([
    [['baptism', 'baptise', 'baptize', 'baptized', 'baptised', 'baptizing', 'baptising', 'baptisms', 'baptist']],
    [['pray', 'prays', 'prayed', 'praying']],
    [['forgive', 'forgives', 'forgiving']],
    [['judge', 'judged', 'judging', 'judgment']],
    [['holy', 'holiness']],
    [['city', 'cities']],
    [['cry', 'cried', 'cries']],
    [['run', 'runs', 'running']],
    [['stop', 'stopped', 'stopping']],
    [['psalm', 'psalms']],
    [['church', 'churches']],
    [['grace', 'graces']],
    [['command', 'commands', 'commandment', 'commandments']],
    [['fall', 'falling']],
    [['pass', 'passed']],
  ])('%j', (family) => {
    expect(new Set(family.map(stem)).size).toBe(1);
  });
});

describe('words that must NOT be conflated or mangled', () => {
  it.each([
    ['Peter', 'pet'],
    ['water', 'wat'],
    ['king', 'k'],
    ['thing', 'th'],
    ['Jesus', 'jesu'],
    ['grass', 'gras'],
    ['genesis', 'genes'],
    ['need', 'ne'],
  ])('%s is not %s', (a, b) => {
    expect(stem(a)).not.toBe(stem(b));
  });

  it('leaves short words alone', () => {
    for (const w of ['the', 'was', 'red', 'bed', 'go']) expect(stem(w)).toBe(w);
  });

  it('keeps a final s that is part of the word', () => {
    expect(stem('Jesus')).toBe('jesus');
    expect(stem('Genesis')).toBe('genesis');
    expect(stem('grass')).toBe('grass');
  });
});

describe('tokenising', () => {
  it('splits on anything that is not a letter or digit, and drops apostrophes', () => {
    expect(words('Christ\'s love — 1 Cor 13!')).toEqual(['christs', 'love', '1', 'cor', '13']);
  });

  it('builds a stem set for a text', () => {
    expect(stemSet('Baptized in the Jordan')).toEqual(new Set(['bapt', 'in', 'the', 'jordan']));
  });
});

describe('matching a query', () => {
  const text = stemSet('Jesus was baptized in the Jordan by John');

  it('finds every word of the query by stem, in any order', () => {
    expect(stemsMatch(text, queryStems('baptism'))).toBe(true);
    expect(stemsMatch(text, queryStems('baptism of Jesus'))).toBe(true);
    expect(stemsMatch(text, queryStems('Jordan baptising'))).toBe(true);
  });

  it('needs EVERY meaningful word, not any', () => {
    expect(stemsMatch(text, queryStems('baptism wilderness'))).toBe(false);
  });

  it('ignores stopwords and words under three letters', () => {
    expect(queryStems('the baptism of a king')).toEqual(['bapt', 'king']);
  });

  it('keeps numbers, so \'psalm 23\' needs the 23', () => {
    expect(queryStems('psalm 23')).toEqual(['psalm', '23']);
    expect(stemsMatch(stemSet('Psalm 91'), queryStems('psalm 23'))).toBe(false);
    expect(stemsMatch(stemSet('Psalms 23'), queryStems('psalm 23'))).toBe(true);
  });

  it('matches whole words only — a short stem cannot match inside a longer word', () => {
    expect(stemsMatch(stemSet('Jordan'), queryStems('jor'))).toBe(false);
  });

  it('matches nothing for a query with nothing to stem on', () => {
    expect(stemsMatch(text, queryStems('the a of'))).toBe(false);
    expect(stemsMatch(text, [])).toBe(false);
  });
});
