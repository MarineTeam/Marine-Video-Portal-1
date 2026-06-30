export default function Layout({ user, children }) {
  return (
    <div className="shell">
      <header className="header">
        <div className="header-inner">
          <a href="/" className="logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 19.5C2.5 19.5 5 17 8 17s5.5 2 8.5 2 5.5-2.5 5.5-2.5V4.5S19.5 7 16.5 7 11 5 8 5 2.5 7.5 2.5 7.5V19.5z"/>
              <line x1="12" y1="5" x2="12" y2="19"/>
            </svg>
            Marine Video Portal
          </a>
          <nav className="nav">
            {user ? (
              <>
                <span className="nav-email">{user.email}</span>
                <a href="/admin" className="btn btn-ghost btn-sm">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  Admin
                </a>
                <a href="/api/auth/logout" className="btn btn-outline btn-sm">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  Sign out
                </a>
              </>
            ) : (
              <a href="/api/auth/login" className="btn btn-primary btn-sm">Sign in</a>
            )}
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
