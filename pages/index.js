import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import AppShell from '../components/AppShell';
import NotifyButton from '../components/NotifyButton';
import { IconPlay, IconLock, IconSearch, IconX } from '../components/icons';
import { linkedQuery } from '../lib/searchLink';

export default function Home() {
  const { user, isLoading } = useUser();
  const [data, setData] = useState({ videos: [], page: 1, totalPages: 1 });
  const [notApproved, setNotApproved] = useState(false);
  const [geoBlocked, setGeoBlocked] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const router = useRouter();

  // A link can open the library already searched — the watch page's passage
  // links do (/?q=Philippians%202). Read once the router has the URL.
  const linked = router.isReady ? linkedQuery(router.query.q) : '';
  useEffect(() => {
    if (!linked) return;
    setQuery(linked);
    setPage(1);
  }, [linked]);
  const [collection, setCollection] = useState('');
  const [collections, setCollections] = useState([]);
  const [progress, setProgress] = useState([]);
  const [savedIds, setSavedIds] = useState([]);
  // "Browse by book": the books this viewer's library cites, from
  // /api/videos?index=books (same gate, same group and schedule filters as
  // the list). An empty or failed answer just hides the row.
  const [books, setBooks] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  // Access request (shown only on the not-approved screen).
  const [accessRequest, setAccessRequest] = useState(null);
  const [requestNote, setRequestNote] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState(null);

  useEffect(() => {
    if (!user) return;
    fetch('/api/videos?index=books')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBooks(d?.books || []))
      .catch(() => {});
  }, [user]);

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
    if (!user || !notApproved) return;
    fetch('/api/access-request')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAccessRequest(d?.request || null))
      .catch(() => {});
  }, [user, notApproved]);

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
    // Saved ids only — the page already holds the library it is allowed to
    // see, so intersecting locally means a saved video that has since left the
    // viewer's access simply matches nothing rather than needing filtering here.
    fetch('/api/mylist')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSavedIds(d?.ids || []))
      .catch(() => {});
  }, [user]);

  async function requestAccess() {
    setRequestBusy(true);
    setRequestError(null);
    try {
      const res = await fetch('/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: requestNote }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data.error || 'Could not send your request. Please try again.');
        return;
      }
      // Approved between page load and clicking — reload rather than showing
      // a "request sent" message to someone who can already get in.
      if (data.alreadyApproved) {
        window.location.reload();
        return;
      }
      setAccessRequest(data.request);
    } catch {
      setRequestError('Could not send your request. Please try again.');
    } finally {
      setRequestBusy(false);
    }
  }

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
    const pending = accessRequest?.status === 'pending';
    const denied = accessRequest?.status === 'denied';
    return (
      <AppShell isAdmin={isAdmin}>
        <div className="card hero">
          <h1>You&rsquo;re signed in, but not approved</h1>
          <p>
            <span className="font-medium">{user.email}</span> isn&rsquo;t on the approved viewer list yet.
          </p>

          {pending ? (
            <p className="request-sent">
              Your access request has been sent and is waiting for an admin to review it.
              You&rsquo;ll be able to sign in and watch as soon as it&rsquo;s approved.
            </p>
          ) : (
            <div className="request-form">
              {denied && (
                <p className="text-muted">
                  A previous request wasn&rsquo;t approved. You can send another if something has changed.
                </p>
              )}
              <label htmlFor="access-note" className="text-muted">
                Tell the admin who you are (optional)
              </label>
              <textarea
                id="access-note"
                className="input"
                rows={3}
                maxLength={500}
                placeholder="e.g. Deck crew, joined in March — Sam asked me to sign up"
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                disabled={requestBusy}
              />
              <button onClick={requestAccess} className="btn btn-primary" disabled={requestBusy}>
                {requestBusy ? 'Sending…' : 'Request access'}
              </button>
              {requestError && <p className="form-error">{requestError}</p>}
            </div>
          )}

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

      {savedIds.length > 0 && (
        <div className="continue-section">
          <h2 className="section-heading">My list</h2>
          <div className="continue-grid">
            {/* Saved order, not library order, and no progress bar: most saved
                videos have never been opened, and an empty bar reads as
                "0% watched" rather than "not started". */}
            {savedIds
              .map((id) => data.videos.find((v) => v.id === id))
              .filter(Boolean)
              .slice(0, 6)
              .map((v) => (
                <a key={v.id} href={`/watch/video/${v.id}`} className="continue-card">
                  <span className="continue-title">{v.title || 'Untitled'}</span>
                </a>
              ))}
          </div>
        </div>
      )}

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

      {books.length > 0 && (
        <details className="book-browse">
          <summary>Browse by book</summary>
          <div className="collection-chips">
            {books.map(({ book, count }) => (
              <button
                key={book}
                className={`chip${query === book ? ' active' : ''}`}
                // The name alone is read as the whole book by the passage
                // search, so this finds exactly the videos counted here.
                onClick={() => { setQuery(book); setPage(1); }}
              >
                {book} <span className="book-count">{count}</span>
              </button>
            ))}
          </div>
        </details>
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

      {/* Said plainly: past the read bound (1,000 videos) the oldest are not
          searched, and a short result list would otherwise read as complete. */}
      {data.truncated && (
        <p className="text-muted">
          This search covers the newest 1,000 videos in the library; older ones are not included.
        </p>
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
