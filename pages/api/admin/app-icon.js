import { requireCapability } from '../../../lib/roles';
import { logAudit } from '../../../lib/audit';
import { validateIconSet } from '../../../lib/appIcon';
import { clearAppIcons, setAppIcons } from '../../../lib/appIconStore';
import { withMonitorApi } from '../../../lib/monitor';

// Sets or resets the app icon. settings:manage (admin-only), like the portal
// name and theme: it is how the portal presents itself on every device.
//
//   PUT    { icons: { 180: base64, 192: base64, 512: base64 } }  -> { version }
//   DELETE                                                        -> built-in icon
//
// The browser resizes; nothing about that is trusted — lib/appIcon.js checks
// every size is a PNG of exactly that size, under a byte cap, before storing.
export const config = { api: { bodyParser: { sizeLimit: '1.5mb' } } };

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'PUT') {
    const result = validateIconSet(req.body?.icons);
    if (!result.ok) return res.status(400).json({ error: result.error });
    try {
      const version = await setAppIcons(result.icons);
      await logAudit(actor, 'settings.app_icon', `set ${version}`);
      return res.json({ version });
    } catch (e) {
      console.error('Could not save the app icon:', e);
      return res.status(502).json({ error: 'Could not save the icon' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await clearAppIcons();
      await logAudit(actor, 'settings.app_icon', 'reset to default');
      return res.json({ ok: true });
    } catch (e) {
      console.error('Could not reset the app icon:', e);
      return res.status(502).json({ error: 'Could not reset the icon' });
    }
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
