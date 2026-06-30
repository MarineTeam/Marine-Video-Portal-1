import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isAdmin } from '../../lib/auth';
import { DEFAULT_THEME, normalizeTheme, isValidHex } from '../../lib/theme';

export default async function handler(req, res) {
  // GET is public so the palette loads for every visitor (including the login page).
  if (req.method === 'GET') {
    const stored = await redis.get(k('theme'));
    return res.json(stored ? normalizeTheme(stored) : DEFAULT_THEME);
  }

  if (req.method === 'POST') {
    const session = await getSession(req, res);
    if (!session || !isAdmin(session?.user?.email)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { accent1, accent2 } = req.body || {};
    if (!isValidHex(accent1) || !isValidHex(accent2)) {
      return res.status(400).json({ error: 'accent1 and accent2 must be #rrggbb hex colors' });
    }
    const theme = { accent1: accent1.toLowerCase(), accent2: accent2.toLowerCase() };
    await redis.set(k('theme'), theme);
    return res.json({ ok: true, ...theme });
  }

  res.status(405).end();
}
