import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import NotifyButton from '../components/NotifyButton';
import { IconPlay, IconLock, IconSearch, IconX } from '../components/icons';

export default function Home() {
  const { user, isLoading } = useUser();
  const [data, setData] = useState({ videos: [], page: 1, totalPages: 1 });
  const [notApproved, setNotApproved] = useState(false);
  const [geoBlocked, setGeoBlocked] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState('');
  const [collections, setCollections] = useState([]);
  const [progress, setProgress] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) return;
    setNotApproved(false);
    setGeoBlocked(false);
    const t = setTimeout(() => {
      fetch(`/api/videos?page=${page}&q=${encodeURIComponent(query)}&collection=${encodeURIComponent(collection)}`).then((r) => {
        if (r.status === 403) {
          r.json().then((d) => {
            if (d.error === 'geo_blocked') setGeoBlocked(true);
            else setNotApproved(true);
          }).catch(() => setNotApproved(true));
          return;
        }
        r.json().then(setData);
      });
    }, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [user, page, query, collection]);

  useEffect(() => {
    if (!user) return;
    // /api/me answers "what may I do" directly. Probing an admin route for
    // a 403 used to work when admin was the only elevated tier; it would
    // report a manager as a plain viewer and hide their Admin link.
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => setIsAdmin(Boolean(me?.isStaff)))
      .catch(() => {});
    fetch('/api/collections').then((r) => (r.ok ? r.json() : [])).then(setCollections).catch(() => {});
    fetch('/api/progress').then((r) => (r.ok ? r.json() : [])).then(setProgress).catch(() => {});
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

  if (geoBlocked) {
    return (
      <AppShell isAdmin={isAdmin}>
        <div className="card hero">
          <h1>Not available in your region</h1>
          <p>This video library isn&rsquo;t available from your current location.</p>
          <a href="/api/auth/logout" className="btn btn-outline">Sign out</a>
        </div>
      </AppShell>
    );
  }

  const inProgress = progress
    .filter((p) => p.seconds > 5 && (!p.duration || p.seconds < p.duration * 0.95))
    .slice(0, 6);

  const hasThumbs = data.videos.some((v) => v.thumbnail);

  return (
    <AppShell isAdmin={isAdmin}>
      <div className="home-toolbar">
        <NotifyButton />
      </div>

      {inProgress.length > 0 && (
        <div className="continue-section">
          <h2 className="section-heading">Continue watching</h2>
          <div className="continue-grid">
            {inProgress.map((p) => (
              <a key={p.id} href={`/watch/video/${p.id}`} className="continue-card">
                <span className="continue-title">{p.title || 'Untitled'}</span>
                <span className="continue-bar">
                  <span
                    className="continue-fill"
                    style={{ width: `${p.duration ? Math.min(100, Math.round((p.seconds / p.duration) * 100)) : 5}%` }}
                  />
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {collections.length > 0 && (
        <div className="collection-chips">
          <button
            className={`chip${collection === '' ? ' active' : ''}`}
            onClick={() => { setCollection(''); setQuery(''); setPage(1); }}
          >
            All
          </button>
          {collections.map((c) => (
            <button
              key={c.id}
              className={`chip${collection === c.id ? ' active' : ''}`}
              onClick={() => { setCollection(c.id); setQuery(''); setPage(1); }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="search-box">
        <IconSearch className="search-icon" />
        <input
          className="input input-sm"
          placeholder="Search videos…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCollection(''); setPage(1); }}
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
      ) : hasThumbs ? (
        <div className="video-grid">
          {data.videos.map((v) => (
            <a key={v.id} href={`/watch/video/${v.id}`} className="video-card">
              <span className="video-card-thumb">
                {v.thumbnail && (
                  <img
                    src={v.thumbnail}
                    alt=""
                    loading="lazy"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <span className="video-card-play"><IconPlay /></span>
              </span>
              <span className="video-card-title">{v.title || 'Untitled'}</span>
            </a>
          ))}
        </div>
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
