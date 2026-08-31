import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/roles';
import {
  listRequests,
  decideRequest,
  deleteRequest,
  STATUS_APPROVED,
  STATUS_DENIED,
} from '../../../lib/accessRequests';

// The reviewer's half of the access-request flow. Sits behind
// 'viewers:manage' — the same capability as adding a viewer directly, because
// approving a request IS adding a viewer, just with a paper trail.
//
// Approve is the only path here that widens access, and it does exactly what
// the Viewers tab's Add button does (SADD to pvp:approved_viewers). Denying
// and deleting only touch the request record; neither ever removes an
// existing viewer, so a mis-click on a stale row can't revoke someone.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'viewers:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    return res.json(await listRequests());
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  if (req.method === 'POST') {
    const approve = body.status === STATUS_APPROVED;
    if (!approve && body.status !== STATUS_DENIED) {
      return res.status(400).json({ error: 'status must be "approved" or "denied"' });
    }

    let record;
    try {
      record = await decideRequest(email, body.status, actor);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (approve) {
      await redis.sadd(k('approved_viewers'), email);
    }
    await logAudit(actor, approve ? 'access_request.approve' : 'access_request.deny', email);
    return res.json({ ok: true, request: record });
  }

  if (req.method === 'DELETE') {
    await deleteRequest(email);
    await logAudit(actor, 'access_request.delete', email);
    return res.json({ ok: true, email });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
