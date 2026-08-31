import { redis, k } from './redis';

// Self-serve access requests. A signed-in user who isn't an approved viewer
// can ask to be let in, instead of the admin having to already know who wants
// access (the "Access-request flow" gap in FEATURES.md).
//
// A request is a CLAIM, never a grant: it stores what the session already
// proves (the Auth0 email) plus a free-text note, and changes nothing about
// what the requester can see. Only an admin or manager acting on it in
// /api/admin/access-requests actually adds them to pvp:approved_viewers.
// Nothing in this module should ever write to the approved set.
//
// One record per email, keyed by email, so repeated asks update the existing
// row rather than piling up — a refresh-spammer produces one pending entry,
// not a thousand.

const KEY = 'access_requests';
const MAX_NOTE_LENGTH = 500;
const MAX_PENDING = 500; // a full queue refuses new asks rather than growing without bound

export const STATUS_PENDING = 'pending';
export const STATUS_APPROVED = 'approved';
export const STATUS_DENIED = 'denied';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Free text typed by an unapproved user — the least trusted input this app
// accepts. It is stored, listed to admins, and (when mail is on) emailed.
// React escapes it on render and lib/mail.js escapes it for HTML, but it is
// still clamped and stripped of control characters here so that neither of
// those is the only line of defence.
export function cleanNote(note) {
  return String(note ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

function parseRecord(raw) {
  if (!raw) return null;
  try {
    // Upstash auto-deserializes JSON-looking strings on read.
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object' || !obj.email) return null;
    return {
      email: String(obj.email),
      note: cleanNote(obj.note),
      status: [STATUS_PENDING, STATUS_APPROVED, STATUS_DENIED].includes(obj.status)
        ? obj.status
        : STATUS_PENDING,
      requestedAt: Number(obj.requestedAt) || null,
      decidedAt: Number(obj.decidedAt) || null,
      decidedBy: obj.decidedBy ? String(obj.decidedBy) : null,
    };
  } catch {
    return null;
  }
}

export async function listRequests() {
  const all = (await redis.hgetall(k(KEY))) || {};
  return Object.values(all)
    .map(parseRecord)
    .filter(Boolean)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
}

export async function getRequest(email) {
  return parseRecord(await redis.hget(k(KEY), normalizeEmail(email)));
}

export function countPending(requests) {
  return (requests || []).filter((r) => r.status === STATUS_PENDING).length;
}

// Returns { ok, record, alreadyPending }. Re-asking while a request is already
// pending is a no-op, so the note of record is the first one sent and a
// refresh loop can't rewrite the queue.
export async function submitRequest(email, note) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');

  const existing = await getRequest(e);
  if (existing && existing.status === STATUS_PENDING) {
    return { ok: true, record: existing, alreadyPending: true };
  }

  if (countPending(await listRequests()) >= MAX_PENDING) {
    throw new Error('The access request queue is full. Please contact an admin directly.');
  }

  const record = {
    email: e,
    note: cleanNote(note),
    status: STATUS_PENDING,
    requestedAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
  };
  await redis.hset(k(KEY), { [e]: JSON.stringify(record) });
  return { ok: true, record, alreadyPending: false };
}

// Records the decision only. Approving does NOT add the viewer here — the
// route does that, so the one place that can widen access stays the one place
// that checked a capability first.
export async function decideRequest(email, status, actor) {
  const e = normalizeEmail(email);
  if (status !== STATUS_APPROVED && status !== STATUS_DENIED) {
    throw new Error('status must be "approved" or "denied"');
  }
  const existing = await getRequest(e);
  if (!existing) throw new Error('Unknown access request');

  const record = {
    ...existing,
    status,
    decidedAt: Date.now(),
    decidedBy: normalizeEmail(actor) || null,
  };
  await redis.hset(k(KEY), { [e]: JSON.stringify(record) });
  return record;
}

export async function deleteRequest(email) {
  await redis.hdel(k(KEY), normalizeEmail(email));
  return { ok: true };
}
