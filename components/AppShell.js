import Head from 'next/head';
import { useUser } from '@auth0/nextjs-auth0/client';
import { IconBrand, IconShield, IconLogOut } from './icons';
import { useSiteName } from './BrandingProvider';

export default function AppShell({ children, isAdmin = false }) {
  const { user } = useUser();
  const siteName = useSiteName();

  return (
    <div className="shell">
      <Head>
        <title>{siteName}</title>
      </Head>
      <header className="shell-header">
        <div className="shell-inner">
          <a href="/" className="shell-brand">
            <IconBrand className="shell-brand-icon" />
            <span>{siteName}</span>
          </a>
          <nav className="shell-nav">
            {user ? (
              <>
                <span className="shell-email">{user.email}</span>
                <a href="/activity" className="btn btn-ghost btn-sm">
                  Activity
                </a>
                {isAdmin && (
                  <a href="/admin" className="btn btn-ghost btn-sm">
                    <IconShield />
                    Admin
                  </a>
                )}
                <a href="/api/auth/logout" className="btn btn-outline btn-sm">
                  <IconLogOut />
                  Sign out
                </a>
              </>
            ) : (
              <a href="/api/auth/login" className="btn btn-primary btn-sm">
                Sign in
              </a>
            )}
          </nav>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}
