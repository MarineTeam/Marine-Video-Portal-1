import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import {
  getGlobalWatermark,
  setGlobalWatermark,
  listWatermarkExemptions,
  addWatermarkExemption,
  removeWatermarkExemption,
} from '../../../lib/watermark';
import { withMonitorApi } from '../../../lib/monitor';

const MAX_EMAIL_LENGTH = 254;

// Same linear (non-regex-backtracking) shape check used for viewer emails —
// good enough to keep the exemption list sane without inviting a ReDoS.
function isLikelyEmail(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const [global, exempt] = await Promise.all([getGlobalWatermark(), listWatermarkExemptions()]);
    return res.json({ global, exempt });
  }

  const body = req.body || {};

  // Global default toggle.
  if (req.method === 'POST' && typeof body.global === 'boolean') {
    await setGlobalWatermark(body.global);
    await logAudit(actor, 'settings.watermark_global', body.global ? 'on' : 'off');
    return res.json({ ok: true, global: body.global });
  }

  // Add one email (viewer or admin) to the exemption list — never watermarked.
  if (req.method === 'POST') {
    const email = String(body.email || '').toLowerCase().trim();
    if (!isLikelyEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    await addWatermarkExemption(email);
    await logAudit(actor, 'watermark.exempt_add', email);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const email = String(body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    await removeWatermarkExemption(email);
    await logAudit(actor, 'watermark.exempt_remove', email);
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
