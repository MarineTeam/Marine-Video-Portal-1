import { getSession } from '@auth0/nextjs-auth0';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';
import { getGeoWhitelist, setGeoWhitelist } from '../../../lib/geo';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    return res.json(await getGeoWhitelist());
  }

  if (req.method === 'POST') {
    const { enabled, countries } = req.body || {};
    const clean = await setGeoWhitelist(enabled, countries);
    await logAudit(
      actor,
      'settings.geo_whitelist',
      `${enabled ? 'on' : 'off'} (${clean.join(', ') || 'none'})`
    );
    return res.json({ ok: true, enabled: Boolean(enabled), countries: clean });
  }

  res.status(405).end();
}
