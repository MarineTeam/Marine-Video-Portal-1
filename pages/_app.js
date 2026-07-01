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

  return (
    <UserProvider>
      <IdleTimeout />
      <Component {...pageProps} />
    </UserProvider>
  );
}
