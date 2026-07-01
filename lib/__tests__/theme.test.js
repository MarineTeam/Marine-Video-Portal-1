import { describe, it, expect } from 'vitest';
import { isValidHex, normalizeTheme, hexToRgba, themeVars, DEFAULT_THEME } from '../theme';

describe('theme helpers', () => {
  it('isValidHex only accepts #rrggbb', () => {
    expect(isValidHex('#2dd4bf')).toBe(true);
    expect(isValidHex('#FFFFFF')).toBe(true);
    expect(isValidHex('#fff')).toBe(false);
    expect(isValidHex('2dd4bf')).toBe(false);
    expect(isValidHex(null)).toBe(false);
  });

  it('normalizeTheme falls back to defaults for invalid input', () => {
    expect(normalizeTheme({ accent1: 'nope', accent2: '#3b82f6' })).toEqual({
      accent1: DEFAULT_THEME.accent1,
      accent2: '#3b82f6',
    });
    expect(normalizeTheme(null)).toEqual(DEFAULT_THEME);
  });

  it('hexToRgba converts to an rgba() string', () => {
    expect(hexToRgba('#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('themeVars derives the gradient and CSS variables', () => {
    const vars = themeVars({ accent1: '#2dd4bf', accent2: '#3b82f6' });
    expect(vars['--accent-1']).toBe('#2dd4bf');
    expect(vars['--accent-2']).toBe('#3b82f6');
    expect(vars['--accent-grad']).toContain('linear-gradient(135deg, #2dd4bf 0%, #3b82f6 100%)');
    expect(vars['--accent-soft']).toContain('rgba(45, 212, 191');
  });
});
