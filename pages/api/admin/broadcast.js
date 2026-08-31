import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import { pushEnabled, targetEmails, sendToEmails } from '../../../lib/push';
import { withMonitorApi } from '../../../lib/monitor';

// Manual push broadcast from the admin Settings tab. Reaches only currently
// approved viewers + admins; dead subscriptions are pruned by sendToEmails.
async function handler(req, res) {
  // Authorize before anything else, including the method check: every other
  // admin route answers an unauthorized caller with 403, and answering 405
  // here told them the route exists and which verb it wants.
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method !== 'POST') return res.status(405).end();

  if (!pushEnabled()) return res.status(503).json({ error: 'Push notifications are not configured' });

  const title = String((req.body && req.body.title) || '').trim() || 'Marine Video Portal';
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });

  let result;
  try {
    const emails = await targetEmails();
    result = await sendToEmails(emails, { title, body, url: '/' });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Broadcast failed' });
  }

  await logAudit(actor, 'push.broadcast', `${result.sent} sent · "${title}"`);
  return res.json({ ok: true, ...result });
}

export default withMonitorApi(handler);
