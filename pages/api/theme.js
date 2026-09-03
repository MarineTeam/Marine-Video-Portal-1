import { redis, k } from '../../lib/redis';
import { requireCapability } from '../../lib/roles';
import { DEFAULT_THEME, normalizeTheme, isValidHex } from '../../lib/theme';
import { logAudit } from '../../lib/audit';
import { getSiteName, setSiteName } from '../../lib/brandingStore';
import { withMonitorApi } from '../../lib/monitor';

async function handler(req, res) {
  // GET is public so the palette loads for every visitor (including the login page).
  if (req.method === 'GET') {
    // Degrades to the defaults rather than 500ing. This endpoint is public and
    // renders the login page's palette and the portal name, so an Upstash blip
    // must not take the sign-in screen down with it — the same fail-soft
    // posture as lib/ratelimit.js and lib/audit.js. (getSiteName already
    // swallows its own errors; this covers the palette read beside it.)
    let stored = null;
    try {
      stored = await redis.get(k('theme'));
    } catch (e) {
      stored = null;
    }
    return res.json({ ...(stored ? normalizeTheme(stored) : DEFAULT_THEME), siteName: await getSiteName() });
  }

  if (req.method === 'POST') {
    // Admin-only: the palette is portal-wide, so it sits with the other
    // settings a Manager deliberately can't reshape.
    const auth = await requireCapability(req, res, 'settings:manage');
    if (!auth) return;
    const body = req.body || {};

    // The site name can be saved on its own, without touching the palette.
    if (Object.prototype.hasOwnProperty.call(body, 'siteName') && body.accent1 === undefined) {
      const siteName = await setSiteName(body.siteName);
      await logAudit(auth.email, 'branding.site_name', siteName);
      return res.json({ ok: true, siteName });
    }

    const { accent1, accent2 } = body;
    if (!isValidHex(accent1) || !isValidHex(accent2)) {
      return res.status(400).json({ error: 'accent1 and accent2 must be #rrggbb hex colors' });
    }
    const theme = { accent1: accent1.toLowerCase(), accent2: accent2.toLowerCase() };
    await redis.set(k('theme'), theme);
    await logAudit(auth.email, 'theme.update', `${theme.accent1} / ${theme.accent2}`);
    return res.json({ ok: true, ...theme });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
