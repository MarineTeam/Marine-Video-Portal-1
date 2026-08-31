import { describe, it, expect } from 'vitest';
import { canSeeVideo, filterVideos, filterCollections, UNRESTRICTED } from '../groups';

const restricted = (over = {}) => ({
  restricted: true,
  groupIds: ['g1'],
  collectionIds: [],
  videoIds: [],
  ...over,
});

const V = {
  inDeck: { guid: 'v-deck', title: 'Deck', collectionId: 'c-deck' },
  inEngine: { guid: 'v-engine', title: 'Engine', collectionId: 'c-engine' },
  loose: { guid: 'v-loose', title: 'Loose', collectionId: '' },
};

// THE opt-in rule: a viewer in no group is unrestricted and keeps the whole
// library. If this ever flips, deploying groups blanks the library for every
// existing viewer at once — see the header comment in lib/groups.js.
describe('unrestricted access', () => {
  it('sees every video', () => {
    expect(filterVideos(UNRESTRICTED, Object.values(V))).toHaveLength(3);
    for (const v of Object.values(V)) expect(canSeeVideo(UNRESTRICTED, v)).toBe(true);
  });

  it('sees every collection', () => {
    const cols = [{ id: 'c-deck' }, { id: 'c-engine' }];
    expect(filterCollections(UNRESTRICTED, cols)).toHaveLength(2);
  });

  it('treats a missing or malformed access object as unrestricted', () => {
    expect(canSeeVideo(null, V.inDeck)).toBe(true);
    expect(canSeeVideo(undefined, V.inDeck)).toBe(true);
    expect(filterVideos(null, Object.values(V))).toHaveLength(3);
  });
});

describe('restricted access', () => {
  it('grants a whole collection', () => {
    const access = restricted({ collectionIds: ['c-deck'] });
    expect(canSeeVideo(access, V.inDeck)).toBe(true);
    expect(canSeeVideo(access, V.inEngine)).toBe(false);
    expect(canSeeVideo(access, V.loose)).toBe(false);
  });

  it('grants an individual video outside any granted collection', () => {
    const access = restricted({ videoIds: ['v-engine'] });
    expect(canSeeVideo(access, V.inEngine)).toBe(true);
    expect(canSeeVideo(access, V.inDeck)).toBe(false);
  });

  it('unions collection and video grants', () => {
    const access = restricted({ collectionIds: ['c-deck'], videoIds: ['v-loose'] });
    expect(filterVideos(access, Object.values(V)).map((v) => v.guid)).toEqual(['v-deck', 'v-loose']);
  });

  // A group with members but no grants is a real state an admin can create.
  // It must show nothing rather than silently falling back to everything.
  it('shows nothing when the group grants nothing', () => {
    expect(filterVideos(restricted(), Object.values(V))).toEqual([]);
  });

  it('never matches a video with no collection against a collection grant', () => {
    const access = restricted({ collectionIds: ['c-deck', ''] });
    expect(canSeeVideo(access, V.loose)).toBe(false);
  });

  it('hides collections the groups do not grant', () => {
    const access = restricted({ collectionIds: ['c-deck'] });
    const cols = [{ id: 'c-deck', name: 'Deck' }, { id: 'c-engine', name: 'Engine' }];
    expect(filterCollections(access, cols).map((c) => c.id)).toEqual(['c-deck']);
  });

  it('handles a missing video', () => {
    expect(canSeeVideo(restricted({ videoIds: ['v-deck'] }), null)).toBe(false);
  });
});
