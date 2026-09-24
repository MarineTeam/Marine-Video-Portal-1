import crypto from 'crypto';
import { redis, k } from './redis';
import { ICON_SIZES } from './appIcon';

// Redis side of the admin-set app icon (lib/appIcon.js validates it).
//
//   k('app_icon')  version -> 'v<hex>', s180 / s192 / s512 -> base64 PNG
//
// The version is written LAST and cleared FIRST, so a reader that sees a
// version always finds the whole set behind it. It carries a letter prefix
// because Upstash JSON-parses stored strings where it can: an all-digit hex
// version would come back as a number, and a long one would lose precision.

export async function getAppIconVersion() {
  const v = await redis.hget(k('app_icon'), 'version');
  return typeof v === 'string' && /^v[0-9a-f]{12}$/.test(v) ? v : null;
}

export async function getAppIcon(size) {
  if (!ICON_SIZES.includes(size)) return null;
  const r = redis;
  const [version, data] = await Promise.all([
    r.hget(k('app_icon'), 'version'),
    r.hget(k('app_icon'), `s${size}`),
  ]);
  if (!version || typeof data !== 'string' || !data) return null;
  return { version: String(version), bytes: Buffer.from(data, 'base64') };
}

// `icons` is validateIconSet()'s output: { size: Buffer }. One write per size
// keeps each Upstash request small.
export async function setAppIcons(icons) {
  const r = redis;
  const hash = crypto.createHash('sha256');
  for (const size of ICON_SIZES) hash.update(icons[size]);
  const version = `v${hash.digest('hex').slice(0, 12)}`;
  await r.hdel(k('app_icon'), 'version');
  for (const size of ICON_SIZES) {
    await r.hset(k('app_icon'), { [`s${size}`]: icons[size].toString('base64') });
  }
  await r.hset(k('app_icon'), { version });
  return version;
}

export async function clearAppIcons() {
  const r = redis;
  await r.hdel(k('app_icon'), 'version');
  await r.del(k('app_icon'));
}
