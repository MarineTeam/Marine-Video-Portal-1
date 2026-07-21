import { redis, k } from './redis';

// Layered watermark control: a global admin default, overridable per video,
// overridable again per share — and an exemption list that wins over all of
// it. Only 'always'/'never' are ever stored for a video or share override;
// "inherit the layer below" is represented by the field being ABSENT, not by
// a third stored value, per the "additive, stored only when explicitly set"
// design.

export async function getGlobalWatermark() {
  const v = await redis.get(k('watermark_global'));
  return v === '1' || v === 1 || v === true;
}

export async function setGlobalWatermark(enabled) {
  await redis.set(k('watermark_global'), enabled ? '1' : '0');
}

export async function isWatermarkExempt(email) {
  if (!email) return false;
  return Boolean(await redis.sismember(k('watermark_exempt'), email));
}

export async function listWatermarkExemptions() {
  const emails = await redis.smembers(k('watermark_exempt'));
  return (emails || []).sort();
}

export async function addWatermarkExemption(email) {
  await redis.sadd(k('watermark_exempt'), email);
}

export async function removeWatermarkExemption(email) {
  await redis.srem(k('watermark_exempt'), email);
}

export async function getVideoWatermarkMode(videoId) {
  const v = await redis.hget(k('watermark_video'), videoId);
  return v === 'always' || v === 'never' ? v : null;
}

export async function listVideoWatermarkModes() {
  return (await redis.hgetall(k('watermark_video'))) || {};
}

// mode 'always'/'never' stores an override; anything else ('default', null,
// undefined) clears it back to inheriting the global setting.
export async function setVideoWatermarkMode(videoId, mode) {
  if (mode === 'always' || mode === 'never') {
    await redis.hset(k('watermark_video'), { [videoId]: mode });
  } else {
    await redis.hdel(k('watermark_video'), videoId);
  }
}

// Precedence: an exemption always wins. Below that, the most specific
// explicit setting wins — share overrides video, video overrides the global
// default. `shareMode`/`videoMode` are 'always' | 'never' | null|undefined
// (undefined/null = not explicitly set at that layer, fall through).
export function resolveWatermark({ exempt, shareMode, videoMode, globalDefault }) {
  if (exempt) return false;
  if (shareMode === 'always') return true;
  if (shareMode === 'never') return false;
  if (videoMode === 'always') return true;
  if (videoMode === 'never') return false;
  return Boolean(globalDefault);
}
