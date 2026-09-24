// Comments under a video: the rules, with no Redis and no fetch.
//
// PURE — the storage is lib/commentsStore.js, the gate is pages/api/comments.js.
//
// WHO SEES WHAT, decided by the owner (2026-09-24):
//   * everyone who can watch a video can read its comments and add one;
//   * a comment appears at once; its author can delete it, and so can anyone
//     holding comments:manage (admins and managers);
//   * other viewers see the author's ACCOUNT NAME, never their email.
//
// The email is stored — it is how 'your own comment' and 'delete my own' are
// decided — but it never leaves the server for a viewer. Only a caller who
// may already manage the viewer list (viewers:manage) is shown it, for the same
// reason the viewer list itself is gated: an email is people data
// (architecture contract, Decision 19).

export const MAX_COMMENT_LENGTH = 1000;
export const MAX_COMMENTS_PER_VIDEO = 500;
export const MAX_NAME_LENGTH = 60;

// Control characters (keeping newlines), zero-width characters and bidi
// overrides — the ones that make text render differently from how it reads,
// or impersonate someone else's name.
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Returns { ok: true, text } or { ok: false, error }. Too long is REFUSED, not
// cut: a comment that silently lost its ending says something its author did
// not write.
export function cleanCommentText(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Write a comment first' };
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return { ok: false, error: 'Write a comment first' };
  if (text.length > MAX_COMMENT_LENGTH) {
    return { ok: false, error: `Comments can be at most ${MAX_COMMENT_LENGTH} characters` };
  }
  return { ok: true, text };
}

// The name other viewers see: the account's profile name, or the part of the
// email before the @ when there is none. Many logins set the profile name TO
// the email address, so a name that looks like one is treated the same way —
// otherwise the rule 'never show the email' would be broken by the profile.
export function displayName(profileName, email) {
  const fromEmail = (value) => String(value || '').split('@')[0];
  let name = String(profileName || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!name || name.includes('@')) name = fromEmail(name.includes('@') ? name : email);
  name = name.slice(0, MAX_NAME_LENGTH).trim();
  return name || 'A viewer';
}

// Letter-prefixed on purpose: the Redis client turns an all-digit string into
// a number, and an id must round-trip as the same string.
export function commentId(now = Date.now(), random = Math.random) {
  const rand = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
  return `c${now.toString(36)}${rand}`;
}

const ID = /^c[0-9a-z]{6,20}$/;
export function isCommentId(value) {
  return typeof value === 'string' && ID.test(value);
}

// A stored comment, or null if the record is unusable. Records are written
// only by lib/commentsStore.js, but a hand-edited or half-written one must
// not break the whole list.
export function parseComment(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  if (!isCommentId(value.id) || typeof value.email !== 'string' || typeof value.text !== 'string') {
    return null;
  }
  const at = Number(value.at);
  return {
    id: value.id,
    email: value.email,
    name: displayName(value.name, value.email),
    text: value.text,
    at: Number.isFinite(at) ? at : 0,
  };
}

// Oldest first — a conversation reads top to bottom.
export function sortComments(list) {
  return [...(list || [])].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

// What one caller is shown. `email` is the caller's; `canModerate` is
// comments:manage; `canSeeEmails` is viewers:manage.
export function commentView(comment, { email, canModerate = false, canSeeEmails = false } = {}) {
  const mine = Boolean(email) && comment.email === email;
  const view = {
    id: comment.id,
    name: comment.name,
    text: comment.text,
    at: comment.at,
    mine,
    canDelete: mine || canModerate,
  };
  if (canSeeEmails) view.email = comment.email;
  return view;
}
