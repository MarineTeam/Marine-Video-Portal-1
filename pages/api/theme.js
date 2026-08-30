import { redis, k } from '../../lib/redis';
import { requireCapability } from '../../lib/roles';
import { DEFAULT_THEME, normalizeTheme, isValidHex } from '../../lib/theme';
import { logAudit } from '../../lib/audit';
import { withMonitorApi } from '../../lib/monitor';

async function handler(req, res) {
  // GET is public so the palette loads for every visitor (including the login page).
  if (req.method === 'GET') {
    const stored = await redis.get(k('theme'));
    return res.json(stored ? normalizeTheme(stored) : DEFAULT_THEME);
  }

  if (req.method === 'POST') {
    // Admin-only: the palette is portal-wide, so it sits with the other
    // settings a Manager deliberately can't reshape.
    const auth = await requireCapability(req, res, 'settings:manage');
    if (!auth) return;
    const { accent1, accent2 } = req.body || {};
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
