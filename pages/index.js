import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import { IconPlay, IconLock, IconSearch, IconX } from '../components/icons';

export default function Home() {
  const { user, isLoading } = useUser();
  const [data, setData] = useState({ videos: [], page: 1, totalPages: 1 });
  const [notApproved, setNotApproved] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) return;
    setNotApproved(false);
    const t = setTimeout(() => {
      fetch(`/api/videos?page=${page}&q=${encodeURIComponent(query)}`).then((r) => {
        if (r.status === 403) { setNotApproved(true); return; }
        r.json().then(setData);
      });
    }, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [user, page, query]);

  useEffect(() => {
    if (!user) return;
    fetch('/api/admin/settings').then((r) => { if (r.ok) setIsAdmin(true); });
  }, [user]);

  if (isLoading) {
    return (
      <AppShell>
        <p className="text-muted">Loading…</p>
      </AppShell>
    );
  }

  if (!user) {
    return (
      <AppShell>
        <div className="card hero">
          <IconLock className="hero-icon" />
          <h1>Sign in to continue</h1>
          <p>This portal is private. Approved viewers can sign in to access the video library.</p>
          <a href="/api/auth/login" className="btn btn-primary">Sign in</a>
        </div>
      </AppShell>
    );
  }

  if (notApproved) {
    return (
      <AppShell isAdmin={isAdmin}>
        <div className="card hero">
          <h1>You&rsquo;re signed in, but not approved</h1>
          <p>
            <span className="font-medium">{user.email}</span> isn&rsquo;t on the approved viewer list yet.
            Please ask the admin to add you.
          </p>
          <a href="/api/auth/logout" className="btn btn-outline">Sign out</a>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell isAdmin={isAdmin}>
      <div className="search-box">
        <IconSearch className="search-icon" />
        <input
          className="input input-sm"
          placeholder="Search videos…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        />
        {query && (
          <button className="btn btn-icon" onClick={() => { setQuery(''); setPage(1); }} title="Clear search">
            <IconX />
          </button>
        )}
      </div>

      {data.videos.length === 0 ? (
        <p className="text-muted">
          {query ? 'No videos match your search.' : 'No videos have been published yet.'}
        </p>
      ) : (
        <ul className="video-list">
          {data.videos.map((v) => (
            <li key={v.id} className="video-row">
              <a href={`/watch/video/${v.id}`}>
                <span className="video-title">{v.title || 'Untitled'}</span>
                <span className="video-meta">
                  <IconPlay />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {data.totalPages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-outline btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="pagination-info">Page {data.page} of {data.totalPages}</span>
          <button
            className="btn btn-outline btn-sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </AppShell>
  );
}
