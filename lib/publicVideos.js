import { redis, k } from './redis';

// Videos an admin has deliberately made viewable WITHOUT a login.
//
// This is the one place in the portal that widens access rather than
// narrowing it, so it is deliberately the smallest possible thing: a set of
// video guids, one boolean per video, and nothing else. Everything that reads
// it treats absence as private.
//
// NOTE THE INVERTED FAILURE POSTURE. Every other optional module here fails
// OPEN — the rate limiter, group resolution, schedules, chapters — because
// failing closed would lock out legitimate viewers. This one fails CLOSED: a
// Redis error means `isPublicVideo` returns false and the public page shows
// "not available". Failing open here would publish the library to the
// internet during an Upstash blip, which is categorically worse than a public
// link being briefly unavailable. Do not "make this consistent" with the
// others.

const KEY = 'public_videos';

export async function isPublicVideo(videoId) {
  const id = String(videoId || '');
  if (!id) return false;
  try {
    return Boolean(await redis.sismember(k(KEY), id));
  } catch {
    return false; // fail closed — see the note above
  }
}

export async function listPublicVideos() {
  try {
    return (await redis.smembers(k(KEY))) || [];
  } catch {
    return [];
  }
}

export async function setPublicVideo(videoId, isPublic) {
  const id = String(videoId || '');
  if (!id) throw new Error('videoId required');
  if (isPublic) {
    await redis.sadd(k(KEY), id);
  } else {
    await redis.srem(k(KEY), id);
  }
  return { videoId: id, isPublic: Boolean(isPublic) };
}

// Called when a video is deleted, so a deleted guid can't linger in the
// public set and match some future video that happened to reuse the id.
export async function clearPublicVideo(videoId) {
  try {
    await redis.srem(k(KEY), String(videoId));
  } catch {
    // best-effort cleanup
  }
}
