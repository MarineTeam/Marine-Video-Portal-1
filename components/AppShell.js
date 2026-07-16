import { useUser } from '@auth0/nextjs-auth0/client';
import { IconAnchor, IconShield, IconLogOut } from './icons';

export default function AppShell({ children, isAdmin = false }) {
  const { user } = useUser();

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-inner">
          <a href="/" className="shell-brand">
            <IconAnchor className="shell-brand-icon" />
            <span>Marine Video Portal</span>
          </a>
          <nav className="shell-nav">
            {user ? (
              <>
                <span className="shell-email">{user.email}</span>
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
