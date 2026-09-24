// lib/appIcon.js — what an uploaded app icon must be before it is stored.
//
// The icon is served from this origin to anyone, signed in or not, so the
// bar is: a PNG (by signature and header, not by what the upload claims), of
// EXACTLY the size it is filed under, under a byte cap — and nothing else.
import { describe, expect, it } from 'vitest';
import { ICON_SIZES, MAX_ICON_BYTES, iconSize, pngDimensions, validateIconSet } from '../appIcon';

// A PNG signature plus an IHDR chunk header is all pngDimensions reads.
function png(width, height, extraBytes = 0) {
  const bytes = Buffer.alloc(33 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const b64 = (buf) => buf.toString('base64');
const goodSet = () => Object.fromEntries(ICON_SIZES.map((s) => [s, b64(png(s, s))]));

describe('pngDimensions', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(pngDimensions(png(512, 512))).toEqual({ width: 512, height: 512 });
  });

  it('refuses anything that is not a PNG', () => {
    expect(pngDimensions(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(pngDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(30).fill(0)]))).toBeNull(); // JPEG
    expect(pngDimensions(Buffer.alloc(10))).toBeNull();
    expect(pngDimensions(null)).toBeNull();
  });

  it('refuses a PNG signature not followed by IHDR', () => {
    const bytes = png(512, 512);
    bytes.write('IDAT', 12, 'ascii');
    expect(pngDimensions(bytes)).toBeNull();
  });
});

describe('validateIconSet', () => {
  it('accepts one PNG of exactly each size', () => {
    const result = validateIconSet(goodSet());
    expect(result.ok).toBe(true);
    expect(Object.keys(result.icons).map(Number)).toEqual(ICON_SIZES);
  });

  it('refuses a missing size', () => {
    const set = goodSet();
    delete set[180];
    expect(validateIconSet(set)).toMatchObject({ ok: false, error: expect.stringContaining('180') });
  });

  it('refuses an image filed under the wrong size', () => {
    const set = goodSet();
    set[192] = b64(png(512, 512));
    expect(validateIconSet(set)).toMatchObject({ ok: false, error: expect.stringContaining('192') });
  });

  it('refuses a non-square image', () => {
    const set = goodSet();
    set[512] = b64(png(512, 511));
    expect(validateIconSet(set).ok).toBe(false);
  });

  it('refuses an SVG, whatever it is filed as', () => {
    const set = goodSet();
    set[512] = b64(Buffer.from('<svg onload=alert(1)></svg>'));
    expect(validateIconSet(set)).toMatchObject({ ok: false, error: expect.stringContaining('not a PNG') });
  });

  it('refuses an oversized upload before decoding it', () => {
    const set = goodSet();
    set[512] = b64(png(512, 512, MAX_ICON_BYTES[512] + 1024));
    expect(validateIconSet(set)).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
  });

  it('refuses something that is not base64, or not an object', () => {
    const set = goodSet();
    set[180] = 'not base64!';
    expect(validateIconSet(set).ok).toBe(false);
    expect(validateIconSet(null).ok).toBe(false);
    expect(validateIconSet([1, 2, 3]).ok).toBe(false);
  });
});

describe('iconSize', () => {
  it('accepts only the sizes that exist', () => {
    expect(iconSize('512')).toBe(512);
    expect(iconSize('192.png')).toBe(192);
    expect(iconSize('64')).toBeNull();
    expect(iconSize('../x')).toBeNull();
    expect(iconSize(undefined)).toBeNull();
  });
});
