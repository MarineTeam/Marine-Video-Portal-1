import { UserProvider } from '@auth0/nextjs-auth0/client';
import { useEffect } from 'react';
import { applyTheme } from '../lib/theme';
import IdleTimeout from '../components/IdleTimeout';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    fetch('/api/theme')
      .then((r) => r.json())
      .then((theme) => {
        applyTheme(theme);
        try { localStorage.setItem('mvp_theme', JSON.stringify(theme)); } catch (e) {}
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
      <IdleTimeout />
      <Component {...pageProps} />
    </UserProvider>
  );
}
