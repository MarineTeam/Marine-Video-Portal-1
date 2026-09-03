import { Html, Head, Main, NextScript } from 'next/document';

// Applies the last-known palette from localStorage before first paint, so a
// returning visitor never sees a flash of the default colors. The authoritative
// palette is fetched from /api/theme in _app and written back to localStorage.
const noFlashTheme = `
(function () {
  try {
    var raw = localStorage.getItem('mvp_theme');
    if (!raw) return;
    var t = JSON.parse(raw);
    var hex = /^#[0-9a-fA-F]{6}$/;
    if (!hex.test(t.accent1) || !hex.test(t.accent2)) return;
    function rgba(h, a) {
      h = h.replace('#', '');
      return 'rgba(' + parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', ' + parseInt(h.slice(4, 6), 16) + ', ' + a + ')';
    }
    var s = document.documentElement.style;
    s.setProperty('--accent-1', t.accent1);
    s.setProperty('--accent-2', t.accent2);
    s.setProperty('--accent-grad', 'linear-gradient(135deg, ' + t.accent1 + ' 0%, ' + t.accent2 + ' 100%)');
    s.setProperty('--accent-soft', rgba(t.accent1, 0.14));
    s.setProperty('--glow-1', rgba(t.accent1, 0.1));
    s.setProperty('--glow-2', rgba(t.accent2, 0.12));
    s.setProperty('--shadow-glow', '0 8px 30px -10px ' + rgba(t.accent2, 0.45));
  } catch (e) {}
})();
`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Served from an API route so the installed app carries the admin-set portal name. */}
        <link rel="manifest" href="/api/manifest" />
        <meta name="theme-color" content="#070b14" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: noFlashTheme }} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
