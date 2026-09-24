// lib/comments.js — what a comment may contain, what name it shows, and what
// each caller is told about it.
import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH,
  cleanCommentText,
  commentId,
  commentView,
  displayName,
  isCommentId,
  parseComment,
  sortComments,
} from "../comments";

describe("cleanCommentText", () => {
  it("trims, keeps line breaks, and folds long gaps", () => {
    expect(cleanCommentText("  Amen.\r\nThank you  \n\n\n\nGreat talk ")).toEqual({
      ok: true,
      text: "Amen.\nThank you\n\nGreat talk",
    });
  });

  it("strips invisible and direction-changing characters", () => {
    // A right-to-left override makes text read differently from what it says.
    const [rlo, zws, bell] = [0x202e, 0x200b, 0x07].map((c) => String.fromCharCode(c));
    expect(cleanCommentText(`abc${rlo}def${zws}${bell}`).text).toBe("abcdef");
  });

  it("refuses an empty comment, and a non-string", () => {
    expect(cleanCommentText("   \n ").ok).toBe(false);
    expect(cleanCommentText(null).ok).toBe(false);
    expect(cleanCommentText({ text: "hi" }).ok).toBe(false);
  });

  it("REFUSES a comment that is too long rather than cutting it", () => {
    expect(cleanCommentText("x".repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    const tooLong = cleanCommentText("x".repeat(MAX_COMMENT_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toMatch(/at most/);
  });
});

describe("displayName — never the email", () => {
  it("uses the profile name", () => {
    expect(displayName("Jane Smith", "jane@example.com")).toBe("Jane Smith");
  });

  it("falls back to the part of the email before the @", () => {
    expect(displayName("", "jane.smith@example.com")).toBe("jane.smith");
    expect(displayName(null, "jane@example.com")).toBe("jane");
  });

  it("does not show a profile name that IS an email address", () => {
    // Many logins set the profile name to the email itself.
    expect(displayName("jane@example.com", "jane@example.com")).toBe("jane");
  });

  it("strips invisible characters, collapses spaces, and caps the length", () => {
    expect(displayName(`  Jane ${String.fromCharCode(0x202e)}  Smith `, "j@x.com")).toBe("Jane Smith");
    expect(displayName("J".repeat(200), "j@x.com")).toHaveLength(MAX_NAME_LENGTH);
  });

  it("never comes back empty", () => {
    expect(displayName("", "")).toBe("A viewer");
  });
});

describe("ids", () => {
  it("are letter-prefixed, so the Redis client never turns one into a number", () => {
    const id = commentId(1_790_000_000_000, () => 0.5);
    expect(id).toMatch(/^c[0-9a-z]+$/);
    expect(isCommentId(id)).toBe(true);
  });

  it("refuses anything else as an id", () => {
    for (const bad of ["", "123456789", "c", "C123abc", "c12345/../x", null, 42]) {
      expect(isCommentId(bad), String(bad)).toBe(false);
    }
  });
});

describe("parseComment", () => {
  const stored = { id: "cabcdef12", email: "jane@example.com", name: "Jane", text: "Amen", at: 5 };

  it("reads a stored record, whether the client handed back a string or an object", () => {
    expect(parseComment(JSON.stringify(stored))).toEqual(stored);
    expect(parseComment(stored)).toEqual(stored);
  });

  it("drops an unusable record instead of breaking the list", () => {
    expect(parseComment("not json")).toBeNull();
    expect(parseComment({ ...stored, id: "bad" })).toBeNull();
    expect(parseComment({ ...stored, email: undefined })).toBeNull();
    expect(parseComment(null)).toBeNull();
  });

  it("re-derives the shown name, so a stored email-as-name is never shown", () => {
    expect(parseComment({ ...stored, name: "jane@example.com" }).name).toBe("jane");
  });
});

describe("sortComments", () => {
  it("puts the oldest first", () => {
    const list = [
      { id: "c2", at: 20 },
      { id: "c1", at: 10 },
    ];
    expect(sortComments(list).map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("commentView — what a caller is told", () => {
  const comment = { id: "cabcdef12", email: "jane@example.com", name: "Jane", text: "Amen", at: 5 };

  it("never includes the author's email for an ordinary viewer", () => {
    const view = commentView(comment, { email: "bob@example.com" });
    expect(view).toEqual({ id: "cabcdef12", name: "Jane", text: "Amen", at: 5, mine: false, canDelete: false });
    expect(JSON.stringify(view)).not.toContain("jane@example.com");
  });

  it("marks the caller's own comment, which they may delete", () => {
    expect(commentView(comment, { email: "jane@example.com" })).toMatchObject({ mine: true, canDelete: true });
  });

  it("lets a moderator delete any comment, still without the email", () => {
    const view = commentView(comment, { email: "mod@example.com", canModerate: true });
    expect(view.canDelete).toBe(true);
    expect(view.email).toBeUndefined();
  });

  it("shows the email only to a caller who may read the viewer list", () => {
    expect(commentView(comment, { email: "a@example.com", canSeeEmails: true }).email).toBe("jane@example.com");
  });
});
