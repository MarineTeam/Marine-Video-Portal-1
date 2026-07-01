import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const count = await redis.get(k('homepage_video_count'));
    return res.json({ count: count ? Number(count) : 2 });
  }

  if (req.method === 'POST') {
    const { count } = req.body || {};
    const parsed = parseInt(count);
    if (!parsed || parsed < 1 || parsed > 1000) {
      return res.status(400).json({ error: 'count must be between 1 and 1000' });
    }
    await redis.set(k('homepage_video_count'), parsed);
    await logAudit(actor, 'settings.homepage_count', String(parsed));
    return res.json({ ok: true, count: parsed });
  }

  res.status(405).end();
}
