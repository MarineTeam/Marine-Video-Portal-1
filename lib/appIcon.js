// Admin-set app icons: what a valid upload is, decided without trusting it.
//
// PURE — no Redis, no fetch; lib/appIconStore.js holds the bytes and
// pages/api/app-icon/[size].js serves them.
//
// The browser does the resizing (a canvas, in the admin page) and uploads one
// PNG per size, so the server needs no image library. It therefore does not
// trust the browser either: every upload is checked here to BE a PNG, of
// EXACTLY the size it claims, under a byte cap, before anything is stored.
//
// PNG ONLY, deliberately. An icon is served from this origin to anyone,
// signed in or not; an SVG is a document that can carry script, and "it is
// only an icon" is how that ends up executing on the site. A PNG checked by
// its signature and header is inert.

// Which icons exist and where each one falls back to when none is set. 180 is
// the iOS home-screen icon; 192 and 512 are what Chrome/Android install from.
export const ICON_SIZES = [180, 192, 512];

export const DEFAULT_ICON_PATH = {
  180: '/apple-touch-icon.png',
  192: '/icon-192.png',
  512: '/icon-512.png',
};

// Upstash rejects large single requests, and an icon has no business being
// big: a flat 512px PNG is tens of kilobytes. These are generous ceilings.
export const MAX_ICON_BYTES = { 180: 150 * 1024, 192: 150 * 1024, 512: 400 * 1024 };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function iconSize(raw) {
  const n = Number(typeof raw === 'string' ? raw.replace(/\.png$/, '') : raw);
  return ICON_SIZES.includes(n) ? n : null;
}

// Width and height from a PNG's IHDR chunk, or null if the bytes are not a
// PNG. The first chunk of every valid PNG is IHDR, at a fixed offset.
export function pngDimensions(bytes) {
  if (!bytes || bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== 'IHDR') return null;
  const read32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: read32(16), height: read32(20) };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The admin's upload: { 180: base64, 192: base64, 512: base64 }, every size
// required. Returns { ok: true, icons: { size: Buffer } } or
// { ok: false, error }, naming the size that failed.
export function validateIconSet(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Upload an icon' };
  }
  const icons = {};
  for (const size of ICON_SIZES) {
    const value = raw[size] ?? raw[String(size)];
    if (typeof value !== 'string' || !value || !BASE64.test(value)) {
      return { ok: false, error: `The ${size}px icon is missing or not base64` };
    }
    // Checked on the ENCODED length first, so an oversized upload is refused
    // before it is decoded into memory.
    if ((value.length * 3) / 4 > MAX_ICON_BYTES[size] + 3) {
      return { ok: false, error: `The ${size}px icon is too large` };
    }
    const bytes = Buffer.from(value, 'base64');
    const dims = pngDimensions(bytes);
    if (!dims) return { ok: false, error: `The ${size}px icon is not a PNG` };
    if (dims.width !== size || dims.height !== size) {
      return { ok: false, error: `The ${size}px icon is ${dims.width}×${dims.height}, not ${size}×${size}` };
    }
    icons[size] = bytes;
  }
  return { ok: true, icons };
}
