// Shared theme helpers — used by the API, the admin panel, _app, and _document.

export const DEFAULT_THEME = { accent1: '#2dd4bf', accent2: '#3b82f6' };

export const PRESETS = [
  { name: 'Ocean',  accent1: '#2dd4bf', accent2: '#3b82f6' },
  { name: 'Sunset', accent1: '#fb923c', accent2: '#f43f5e' },
  { name: 'Forest', accent1: '#4ade80', accent2: '#14b8a6' },
  { name: 'Grape',  accent1: '#a855f7', accent2: '#6366f1' },
  { name: 'Rose',   accent1: '#fb7185', accent2: '#d946ef' },
  { name: 'Amber',  accent1: '#fbbf24', accent2: '#f97316' },
  { name: 'Slate',  accent1: '#94a3b8', accent2: '#64748b' },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(value) {
  return typeof value === 'string' && HEX.test(value);
}

// Coerce arbitrary input into a safe { accent1, accent2 }, falling back to defaults.
export function normalizeTheme(input) {
  const t = input || {};
  return {
    accent1: isValidHex(t.accent1) ? t.accent1.toLowerCase() : DEFAULT_THEME.accent1,
    accent2: isValidHex(t.accent2) ? t.accent2.toLowerCase() : DEFAULT_THEME.accent2,
  };
}

export function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Map a theme to the CSS custom properties it overrides.
export function themeVars(input) {
  const { accent1, accent2 } = normalizeTheme(input);
  return {
    '--accent-1': accent1,
    '--accent-2': accent2,
    '--accent-grad': `linear-gradient(135deg, ${accent1} 0%, ${accent2} 100%)`,
    '--accent-soft': hexToRgba(accent1, 0.14),
    '--glow-1': hexToRgba(accent1, 0.1),
    '--glow-2': hexToRgba(accent2, 0.12),
    '--shadow-glow': `0 8px 30px -10px ${hexToRgba(accent2, 0.45)}`,
  };
}

// Apply a theme to a DOM element's inline style (defaults to <html>). Client-only.
export function applyTheme(input, el) {
  const target = el || (typeof document !== 'undefined' && document.documentElement);
  if (!target) return;
  const vars = themeVars(input);
  for (const key in vars) target.style.setProperty(key, vars[key]);
}
