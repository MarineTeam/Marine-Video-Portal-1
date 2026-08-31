import { requireCapability } from '../../../lib/roles';
import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { mailEnabled } from '../../../lib/mail';
import { monitorEnabled, withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const count = await redis.get(k('homepage_video_count'));
    return res.json({
      count: count ? Number(count) : 2,
      mailEnabled: mailEnabled(),
      queryMonitorEnabled: monitorEnabled(),
    });
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

export default withMonitorApi(handler);
