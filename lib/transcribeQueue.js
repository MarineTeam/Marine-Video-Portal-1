// Which queued transcriptions are worth checking on, and when to give up.
//
// PURE MODULE — no Redis, no fetch. The decisions here are the whole of what
// could go wrong with automatic collection (checking too eagerly, checking
// forever, checking everything at once), so they are separated from the doing
// and tested directly.
//
// WHY THIS EXISTS. bunny's transcription is asynchronous and there is no
// webhook, so ingesting the result was a SECOND admin click, minutes after the
// first. An admin who forgot it got a video that looked transcribed —
// transcription really had run and been paid for — with no transcript on the
// watch page and nothing anywhere saying why. The failure was silent, and the
// cost was already sunk.
//
// So queueing now records the guid, and the admin video list collects any that
// have finished. No webhook, no poller, no new infrastructure: the work
// happens on a request an admin was making anyway, which is the same shape as
// the new-video push announce that already rides that route.

// How long to keep trying before giving up on a queued job. bunny transcribes
// a service in minutes; a day means something went wrong that retrying will
// not fix — the video was deleted, the job failed, the key changed. Giving up
// is better than a marker that retries two bunny calls forever.
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Nothing is checked in the first minute. Transcription cannot possibly be
// finished, and the request that queued it would otherwise spend two bunny
// calls proving that.
export const PENDING_GRACE_MS = 60 * 1000;

// At most this many per request. Each is up to two bunny calls, and an admin
// who queued thirty videos should not pay for all thirty on one page load —
// the rest are collected on the next one.
export const MAX_COLLECT_PER_REQUEST = 3;

function ageOf(value, now) {
  const queuedAt = typeof value === 'number' ? value : Date.parse(String(value || ''));
  // An unreadable timestamp is treated as ANCIENT rather than as new, so a
  // corrupt marker expires instead of being retried forever.
  return Number.isFinite(queuedAt) ? now - queuedAt : Number.POSITIVE_INFINITY;
}

// Splits the pending map into what to try now and what to abandon.
//
//   collect  guids old enough to have finished, capped
//   expired  guids past the deadline, to be dropped without another attempt
//
// Oldest first: a job queued an hour ago is likelier to be ready than one
// queued a minute ago, and it is also the one an admin has been waiting for.
export function planCollection(pending, { now = Date.now(), limit = MAX_COLLECT_PER_REQUEST } = {}) {
  const entries = Object.entries(pending && typeof pending === 'object' ? pending : {})
    .map(([guid, value]) => ({ guid: String(guid || '').trim(), age: ageOf(value, now) }))
    .filter((entry) => entry.guid);

  const expired = entries
    .filter((entry) => entry.age > PENDING_MAX_AGE_MS)
    .map((entry) => entry.guid);

  const ready = entries
    .filter((entry) => entry.age >= PENDING_GRACE_MS && entry.age <= PENDING_MAX_AGE_MS)
    .sort((a, b) => b.age - a.age)
    .map((entry) => entry.guid);

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_COLLECT_PER_REQUEST;
  return { collect: ready.slice(0, cap), expired };
}
