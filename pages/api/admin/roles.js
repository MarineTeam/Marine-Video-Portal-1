import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import {
  requireCapability,
  listRoleGrants,
  grantRole,
  revokeRole,
  countRemainingAdmins,
  capabilitiesForRole,
  ROLE_ADMIN,
  ROLE_MANAGER,
} from '../../../lib/roles';

// Admin-only: promote and demote. Two guards that are the whole point of
// this route existing rather than the UI writing the sets directly:
//
//   1. An ADMIN_EMAILS admin can never be demoted here (enforced in
//      lib/roles.js) — that env var is the recovery path.
//   2. The last remaining admin cannot demote or revoke themselves, so the
//      portal can never be left with nobody able to administer it.
//
// Granting a role also adds the person to approved_viewers. A manager who
// isn't an approved viewer would be able to open /admin but not the library
// they're curating, which reads as a bug every single time.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'roles:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const grants = await listRoleGrants();
    return res.json({
      grants,
      managerCapabilities: capabilitiesForRole(ROLE_MANAGER),
      adminCapabilities: capabilitiesForRole(ROLE_ADMIN),
    });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  if (req.method === 'POST') {
    const role = String(body.role || '');
    if (role !== ROLE_ADMIN && role !== ROLE_MANAGER) {
      return res.status(400).json({ error: 'role must be "admin" or "manager"' });
    }

    if (role === ROLE_MANAGER && (await countRemainingAdmins(email)) === 0) {
      return res.status(400).json({
        error: 'That would leave the portal with no admin. Promote someone else first.',
      });
    }

    let result;
    try {
      result = await grantRole(email, role);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await redis.sadd(k('approved_viewers'), email);
    await logAudit(actor, 'role.grant', `${email} → ${role}`);
    return res.json({ ok: true, ...result });
  }

  if (req.method === 'DELETE') {
    if ((await countRemainingAdmins(email)) === 0) {
      return res.status(400).json({
        error: 'That would leave the portal with no admin. Promote someone else first.',
      });
    }
    try {
      await revokeRole(email);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await logAudit(actor, 'role.revoke', email);
    return res.json({ ok: true, email });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
