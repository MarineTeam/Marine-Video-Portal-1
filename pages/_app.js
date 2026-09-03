import { UserProvider } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import { applyTheme } from '../lib/theme';
import { BrandingProvider } from '../components/BrandingProvider';
import IdleTimeout from '../components/IdleTimeout';
import QueryMonitor from '../components/QueryMonitor';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  const [siteName, setSiteName] = useState(null);

  useEffect(() => {
    fetch('/api/theme')
      .then((r) => r.json())
      .then((theme) => {
        applyTheme(theme);
        // The palette cache stays colors-only: the pre-paint script in
        // _document.js reads this key and hex-validates it, so keeping a
        // free-text name out of it means the script's input is still nothing
        // but two hex strings.
        const { siteName: name, ...palette } = theme;
        setSiteName(name || null);
        try { localStorage.setItem('mvp_theme', JSON.stringify(palette)); } catch (e) {}
      })
      .catch(() => {});
  }, []);

  // Register the PWA service worker so the app is installable on desktop and mobile.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  return (
    <UserProvider>
      <BrandingProvider siteName={siteName}>
        <IdleTimeout />
        <Component {...pageProps} />
        <QueryMonitor ssrStats={pageProps._monitor} />
      </BrandingProvider>
    </UserProvider>
  );
}
