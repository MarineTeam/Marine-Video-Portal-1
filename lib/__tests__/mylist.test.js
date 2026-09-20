// lib/mylist.js — the per-viewer saved queue.
//
// The cases that matter are the ones Redis will actually produce: string
// timestamps rather than numbers, a row written by hand, an entry naming a
// video that has since been deleted, and a list at its cap.
import { describe, expect, it } from 'vitest';
import {
  isFull,
  isSaved,
  listCount,
  listIds,
  markSaved,
  MAX_ITEMS,
  normalizeList,
  savedVideos,
} from '../mylist';

const RAW = { "vid-old": 1000, "vid-new": 3000, "vid-mid": 2000 };

describe("normalizeList", () => {
  it("returns entries newest first", () => {
    expect(listIds(RAW)).toEqual(["vid-new", "vid-mid", "vid-old"]);
  });

  // Upstash hands back strings for numeric hash values often enough that
  // treating them as numbers is not optional.
  it("accepts a string timestamp as a number", () => {
    expect(listIds({ a: "3000", b: "1000" })).toEqual(["a", "b"]);
  });

  // The viewer saved it. Losing the entry is worse than misordering it.
  it("keeps an entry with an unparseable timestamp, sorted last", () => {
    const ids = listIds({ good: 5000, junk: "not a time", alsoJunk: null });
    expect(ids[0]).toBe("good");
    expect(ids).toContain("junk");
    expect(ids).toContain("alsoJunk");
  });

  it("breaks a timestamp tie deterministically by id", () => {
    expect(listIds({ b: 1000, a: 1000, c: 1000 })).toEqual(["a", "b", "c"]);
  });

  it("drops blank ids rather than emitting empty rows", () => {
    expect(listIds({ "": 1000, "   ": 2000, ok: 3000 })).toEqual(["ok"]);
  });

  it("trims an id with stray whitespace", () => {
    expect(listIds({ "  padded  ": 1000 })).toEqual(["padded"]);
  });

  it("survives junk input instead of throwing", () => {
    for (const junk of [null, undefined, "", 42, [], "a string"]) {
      expect(normalizeList(junk)).toEqual([]);
    }
  });

  it("caps at MAX_ITEMS, keeping the newest", () => {
    const raw = {};
    for (let i = 0; i < MAX_ITEMS + 25; i += 1) raw[`vid-${i}`] = i;
    const ids = listIds(raw);
    expect(ids).toHaveLength(MAX_ITEMS);
    // Newest first, so the highest index survives and the oldest are cut.
    expect(ids[0]).toBe(`vid-${MAX_ITEMS + 24}`);
    expect(ids).not.toContain("vid-0");
  });
});

describe("isSaved / listCount", () => {
  it("answers membership", () => {
    expect(isSaved(RAW, "vid-mid")).toBe(true);
    expect(isSaved(RAW, "nope")).toBe(false);
  });

  it("is false for a blank or junk id", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      expect(isSaved(RAW, bad)).toBe(false);
    }
  });

  it("counts entries", () => {
    expect(listCount(RAW)).toBe(3);
    expect(listCount(null)).toBe(0);
  });
});

describe("isFull", () => {
  const full = {};
  for (let i = 0; i < MAX_ITEMS; i += 1) full[`vid-${i}`] = i;

  it("is false below the cap", () => {
    expect(isFull(RAW, "anything")).toBe(false);
  });

  it("is true at the cap for a NEW id", () => {
    expect(isFull(full, "brand-new")).toBe(true);
  });

  // Re-saving something already in the list does not grow it, so a full list
  // must not refuse it — that would be a confusing error on a no-op.
  it("is false at the cap for an id already saved", () => {
    expect(isFull(full, "vid-0")).toBe(false);
  });
});

describe("markSaved", () => {
  const videos = [{ id: "vid-new" }, { id: "vid-other" }];

  it("flags which videos are saved", () => {
    const marked = markSaved(videos, RAW);
    expect(marked[0].saved).toBe(true);
    expect(marked[1].saved).toBe(false);
  });

  it("leaves the rest of each video untouched", () => {
    const marked = markSaved([{ id: "vid-new", title: "Sunday" }], RAW);
    expect(marked[0].title).toBe("Sunday");
  });

  it("survives junk", () => {
    expect(markSaved(null, RAW)).toEqual([]);
    expect(markSaved(videos, null).every((v) => v.saved === false)).toBe(true);
  });
});

describe("savedVideos", () => {
  const videos = [{ id: "vid-old" }, { id: "vid-new" }, { id: "unrelated" }];

  it("returns saved videos in saved order, not library order", () => {
    expect(savedVideos(videos, RAW).map((v) => v.id)).toEqual(["vid-new", "vid-old"]);
  });

  // A list entry outlives the video it names when that video is deleted from
  // bunny. A stale entry must not put a hole in the row.
  it("drops an entry whose video no longer exists", () => {
    const ids = savedVideos(videos, { ...RAW, "deleted-video": 9000 }).map((v) => v.id);
    expect(ids).toEqual(["vid-new", "vid-old"]);
  });

  it("returns [] when nothing is saved, and survives junk", () => {
    expect(savedVideos(videos, {})).toEqual([]);
    expect(savedVideos(null, RAW)).toEqual([]);
    expect(savedVideos(videos, null)).toEqual([]);
  });
});
