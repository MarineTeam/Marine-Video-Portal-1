import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import {
  getViewerCountries,
  getAdminCountries,
  isViewerGeoEnabled,
  setViewerGeoEnabled,
  isAdminGeoEnabled,
  setAdminGeoEnabled,
} from '../../../lib/geo';
import { withMonitorApi } from '../../../lib/monitor';

// Country lists are env-configured (GEO_WHITELIST / ADMIN_GEO_WHITELIST) —
// read-only here, deploy-time only. Only the enforcement toggles are
// admin-editable, live, via Redis.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const [viewerEnabled, adminEnabled] = await Promise.all([isViewerGeoEnabled(), isAdminGeoEnabled()]);
    return res.json({
      viewer: { enabled: viewerEnabled, countries: getViewerCountries() },
      admin: { enabled: adminEnabled, countries: getAdminCountries() },
    });
  }

  if (req.method === 'POST') {
    const { viewerEnabled, adminEnabled } = req.body || {};
    if (typeof viewerEnabled === 'boolean') {
      await setViewerGeoEnabled(viewerEnabled);
      await logAudit(actor, 'settings.geo_viewer', viewerEnabled ? 'on' : 'off');
    }
    if (typeof adminEnabled === 'boolean') {
      await setAdminGeoEnabled(adminEnabled);
      await logAudit(actor, 'settings.geo_admin', adminEnabled ? 'on' : 'off');
    }
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
