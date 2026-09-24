import { getSiteName } from '../../lib/brandingStore';
import { getAppIconVersion } from '../../lib/appIconStore';
import { shortSiteName } from '../../lib/branding';

// The PWA manifest is served dynamically so the installed app carries the
// admin's chosen portal name. It replaces the old static
// public/manifest.webmanifest, which hardcoded it.
//
// Public, like GET /api/theme: the browser fetches the manifest without
// credentials and before any login, so requiring a session would simply make
// the app uninstallable.
export default async function handler(req, res) {
  const name = await getSiteName();
  // The admin-set icon, when there is one; an unreadable version means the
  // built-in icons, never a broken manifest.
  const iconVersion = await getAppIconVersion().catch(() => null);

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  // Revalidate every load so a rename shows up on the next install/launch
  // rather than being pinned by an HTTP cache.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

  res.status(200).send(
    JSON.stringify({
      id: '/',
      name,
      short_name: shortSiteName(name),
      description: 'Private, invite-only video portal.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#070b14',
      theme_color: '#070b14',
      // A custom icon replaces ALL of these, the SVG included — left in, a
      // browser preferring vector icons would keep showing the old one — and
      // is offered as 'any' only: an arbitrary image has no safe zone, so as
      // 'maskable' Android would clip its edges.
      icons: iconVersion
        ? [
            { src: `/api/app-icon/192?v=${iconVersion}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: `/api/app-icon/512?v=${iconVersion}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          ]
        : [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
    })
  );
}
