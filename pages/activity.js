import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import { IconChevronLeft } from '../components/icons';

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function Activity() {
  const { user, isLoading } = useUser();
  const [isAdmin, setIsAdmin] = useState(false);
  const [viewers, setViewers] = useState([]);
  const [lookupEmail, setLookupEmail] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    fetch('/api/admin/settings').then((r) => {
      if (r.ok) {
        setIsAdmin(true);
        fetch('/api/admin/viewers').then((rr) => (rr.ok ? rr.json() : [])).then((list) => {
          setViewers(list.map((v) => v.email));
        }).catch(() => {});
      }
    });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const url = lookupEmail ? `/api/progress?email=${encodeURIComponent(lookupEmail)}` : '/api/progress';
    fetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [user, lookupEmail]);

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
        <div className="card watch-error">
          <p style={{ margin: 0 }}>Sign in to see your watch history.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell isAdmin={isAdmin}>
      <div className="watch-back">
        <a href="/" className="btn btn-ghost btn-sm">
          <IconChevronLeft />
          Back to videos
        </a>
      </div>
      <h1 className="watch-title">{lookupEmail ? `${lookupEmail}'s activity` : 'Your activity'}</h1>

      {isAdmin && viewers.length > 0 && (
        <div className="search-box" style={{ maxWidth: 360, marginBottom: 20 }}>
          <select
            className="input input-sm"
            value={lookupEmail}
            onChange={(e) => setLookupEmail(e.target.value)}
          >
            <option value="">Me ({user.email})</option>
            {viewers.map((email) => (
              <option key={email} value={email}>{email}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : history.length === 0 ? (
        <div className="card">
          <p className="text-muted" style={{ margin: 0 }}>Nothing watched yet.</p>
        </div>
      ) : (
        <ul className="bundle-list">
          {history.map((h) => {
            const pct = h.duration ? Math.min(100, Math.round((h.seconds / h.duration) * 100)) : 0;
            return (
              <li key={h.id} className="card bundle-item">
                <div className="bundle-item-info">
                  <a className="bundle-item-title" href={`/watch/video/${h.id}`}>
                    {h.title || 'Untitled'}
                  </a>
                  <span className="share-meta">
                    {pct > 0 ? `watched up to ${pct}%` : 'opened, not yet played'}
                    {h.at ? ` · last watched ${timeAgo(h.at)}` : ''}
                  </span>
                </div>
                <a className="btn btn-outline btn-sm" href={`/watch/video/${h.id}`}>
                  Resume
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
