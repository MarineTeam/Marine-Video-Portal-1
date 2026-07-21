import { describe, it, expect } from 'vitest';
import { resolveWatermark } from '../watermark';

describe('resolveWatermark', () => {
  it('is off by default when nothing is set', () => {
    expect(resolveWatermark({})).toBe(false);
  });

  it('follows the global default when no override exists', () => {
    expect(resolveWatermark({ globalDefault: true })).toBe(true);
    expect(resolveWatermark({ globalDefault: false })).toBe(false);
  });

  it('a video override beats the global default', () => {
    expect(resolveWatermark({ globalDefault: false, videoMode: 'always' })).toBe(true);
    expect(resolveWatermark({ globalDefault: true, videoMode: 'never' })).toBe(false);
  });

  it('a share override beats a video override', () => {
    expect(resolveWatermark({ globalDefault: false, videoMode: 'never', shareMode: 'always' })).toBe(true);
    expect(resolveWatermark({ globalDefault: true, videoMode: 'always', shareMode: 'never' })).toBe(false);
  });

  it('an exemption wins over every other layer', () => {
    expect(
      resolveWatermark({ exempt: true, globalDefault: true, videoMode: 'always', shareMode: 'always' })
    ).toBe(false);
  });
});
