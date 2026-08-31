import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability, listRoleGrants } from '../../../lib/roles';
import {
  isEnforcementEnabled,
  setEnforcementEnabled,
  listObservations,
  summarizeObservations,
  bypassEmails,
} from '../../../lib/verification';

// Admin-only control for optional email_verified enforcement.
//
// GET returns the toggle state alongside the BLAST RADIUS: how many of the
// accounts this app has actually observed signing in would be blocked if the
// toggle went on right now, and which ones. That number is the whole point of
// the endpoint — enforcing this claim blind is what nearly took the portal
// down on 2026-07-10 (failure-archaeology entry 2), and the tenant still has
// no mail server, so the expected answer is "all of them".
//
// POST refuses to enable enforcement unless the caller has seen that number
// and passes `confirm: true`. Staff are exempt from enforcement regardless,
// so an admin can always come back here and switch it off.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const [enabled, observations, grants] = await Promise.all([
      isEnforcementEnabled(),
      listObservations(),
      listRoleGrants(),
    ]);
    return res.json({
      enabled,
      bypassEmails: bypassEmails(),
      summary: summarizeObservations(observations, grants.map((g) => g.email)),
      observations,
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const enabled = Boolean(body.enabled);

    if (enabled && body.confirm !== true) {
      const [observations, grants] = await Promise.all([listObservations(), listRoleGrants()]);
      const summary = summarizeObservations(observations, grants.map((g) => g.email));
      return res.status(400).json({
        error:
          'Enabling email verification needs confirmation. Review how many viewers it would block first.',
        summary,
      });
    }

    await setEnforcementEnabled(enabled);
    await logAudit(actor, 'verification.enforce', enabled ? 'enabled' : 'disabled');
    return res.json({ ok: true, enabled });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
