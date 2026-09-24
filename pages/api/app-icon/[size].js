import { withMonitorApi } from '../../../lib/monitor';
import { DEFAULT_ICON_PATH, iconSize } from '../../../lib/appIcon';
import { getAppIcon } from '../../../lib/appIconStore';

// The app icon at one size: /api/app-icon/180, /192 or /512.
//
// The admin-set icon when there is one (lib/appIcon.js validated it as a PNG
// of exactly this size before it was stored); otherwise a redirect to the
// built-in file, so the URL always answers with an icon — which is why
// _document can point the iOS touch icon here unconditionally.
//
// Public and pre-login, like /api/manifest and for the same reason: a browser
// fetches icons before any session exists, and every visitor gets the same
// picture. This repo has no middleware, so nothing else stands in front of it.
//
// Caching: ?v=<the current version> may be cached for a year (a new icon is a
// new version, so a new URL); anything else only briefly.
async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const size = iconSize(typeof req.query.size === 'string' ? req.query.size : '');
  if (!size) return res.status(404).json({ error: 'Not found' });

  let icon = null;
  try {
    icon = await getAppIcon(size);
  } catch {
    // Cosmetic: an unreadable icon falls back to the default rather than
    // leaving an install prompt without a picture.
  }

  if (!icon) {
    res.setHeader('cache-control', 'public, max-age=300');
    res.setHeader('location', DEFAULT_ICON_PATH[size]);
    res.statusCode = 302;
    return res.end();
  }

  const current = typeof req.query.v === 'string' && req.query.v === icon.version;
  res.setHeader('content-type', 'image/png');
  // Belt and braces for a file served to anyone from this origin: the bytes
  // were checked to be a PNG, and the browser is told not to guess otherwise.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'");
  res.setHeader('cache-control', current ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  res.setHeader('content-length', String(icon.bytes.length));
  res.statusCode = 200;
  return res.end(req.method === 'HEAD' ? undefined : icon.bytes);
}

export default withMonitorApi(handler);
