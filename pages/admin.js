import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import { IconTrash, IconCopy, IconGrip, IconPencil, IconSearch, IconCheck, IconX } from '../components/icons';
import { applyTheme, DEFAULT_THEME, PRESETS, isValidHex } from '../lib/theme';

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

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatDuration(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [activeShares, setActiveShares] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [newViewerEmail, setNewViewerEmail] = useState('');
  const [videoCount, setVideoCount] = useState(2);
  const [expiresHours, setExpiresHours] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('videos');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [themeSaved, setThemeSaved] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const [uploadErrorMsg, setUploadErrorMsg] = useState('');
  const [bulkEmails, setBulkEmails] = useState('');
  const [videoQuery, setVideoQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [dragOverId, setDragOverId] = useState(null);
  const [audit, setAudit] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [collections, setCollections] = useState([]);
  const [newCollection, setNewCollection] = useState('');
  const fileInputRef = useRef(null);
  const uploadRef = useRef(null);
  const uploadVideoIdRef = useRef(null);
  const dragIdRef = useRef(null);

  async function fetchVideos() {
    const r = await fetch('/api/admin/videos');
    if (!r.ok) throw new Error('Forbidden — this account is not an admin');
    setVideos(await r.json());
  }

  useEffect(() => {
    if (!user) return;

    fetchVideos().catch((e) => setError(e.message));
    fetch('/api/admin/viewers').then((r) => r.json()).then(setViewers);
    fetch('/api/admin/settings').then((r) => r.json()).then((d) => setVideoCount(d.count));
    fetch('/api/admin/shares').then((r) => r.json()).then(setActiveShares);
    fetch('/api/theme').then((r) => r.json()).then(setTheme).catch(() => {});
    fetch('/api/admin/collections').then((r) => (r.ok ? r.json() : [])).then(setCollections).catch(() => {});
  }, [user]);

  // While any video is still encoding (status 0–3), re-poll so progress updates.
  useEffect(() => {
    const encoding = videos.some((v) => typeof v.status === 'number' && v.status < 4);
    if (!encoding) return;
    const t = setTimeout(() => { fetchVideos().catch(() => {}); }, 4000);
    return () => clearTimeout(t);
  }, [videos]);

  // Load the audit log the first time the Activity tab is opened (and refresh on revisit).
  useEffect(() => {
    if (!user || tab !== 'activity') return;
    fetch('/api/admin/audit').then((r) => (r.ok ? r.json() : [])).then(setAudit).catch(() => {});
  }, [user, tab]);

  // Load analytics when the Analytics tab is opened (and refresh on revisit).
  useEffect(() => {
    if (!user || tab !== 'analytics') return;
    fetch('/api/admin/analytics').then((r) => (r.ok ? r.json() : null)).then(setAnalytics).catch(() => {});
  }, [user, tab]);

  // Live-preview a palette change across the whole page as the admin edits.
  function previewTheme(next) {
    setTheme(next);
    setThemeSaved(false);
    applyTheme(next);
  }

  function setAccent(which, value) {
    previewTheme({ ...theme, [which]: value });
  }

  async function saveTheme() {
    if (!isValidHex(theme.accent1) || !isValidHex(theme.accent2)) {
      alert('Both colors must be valid #rrggbb hex values.');
      return;
    }
    const res = await fetch('/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || `Failed to save (status ${res.status})`); return; }
    try { localStorage.setItem('mvp_theme', JSON.stringify(theme)); } catch (e) {}
    setThemeSaved(true);
    setTimeout(() => setThemeSaved(false), 2000);
  }

  function failUpload(message, err) {
    if (err) console.error('Video upload failed:', err);
    setUploading(false);
    setUploadError(true);
    setUploadErrorMsg(message || 'Upload failed');
  }

  async function beginUpload() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadError(false);
    setUploadErrorMsg('');
    setUploadPct(0);

    let meta;
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: uploadTitle.trim() || uploadFile.name }),
      });
      meta = await res.json();
      if (!res.ok) throw new Error(meta.error || `Create-video failed (HTTP ${res.status})`);
      if (!meta.videoId) throw new Error('Server did not return a video id');
    } catch (e) {
      failUpload(`Couldn't start upload: ${e.message}`, e);
      return;
    }

    uploadVideoIdRef.current = meta.videoId;

    let Upload;
    try {
      ({ Upload } = await import('tus-js-client'));
    } catch (e) {
      failUpload('Upload library failed to load — try redeploying so tus-js-client installs.', e);
      return;
    }

    const upload = new Upload(uploadFile, {
      endpoint: 'https://video.bunnycdn.com/tusupload',
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        AuthorizationSignature: meta.signature,
        AuthorizationExpire: String(meta.expires),
        VideoId: meta.videoId,
        LibraryId: String(meta.libraryId),
      },
      metadata: { filetype: uploadFile.type, title: meta.title },
      onError: (err) => {
        const status = err?.originalResponse?.getStatus?.();
        failUpload(`Upload failed${status ? ` (HTTP ${status})` : ''}: ${err?.message || err}`, err);
      },
      onProgress: (sent, total) => setUploadPct(Math.round((sent / total) * 100)),
      onSuccess: async () => {
        uploadRef.current = null;
        uploadVideoIdRef.current = null;
        setUploading(false);
        setUploadError(false);
        setUploadErrorMsg('');
        setUploadFile(null);
        setUploadTitle('');
        setUploadPct(0);
        if (fileInputRef.current) fileInputRef.current.value = '';
        await fetchVideos().catch(() => {});
      },
    });
    uploadRef.current = upload;
    upload.start();
  }

  // Resume the same upload after a failure — TUS picks up where it left off.
  function retryUpload() {
    if (!uploadRef.current) { beginUpload(); return; }
    setUploadError(false);
    setUploadErrorMsg('');
    setUploading(true);
    uploadRef.current.start();
  }

  // Stop the in-flight upload and remove the half-created video from bunny.net.
  async function cancelUpload() {
    if (uploadRef.current) {
      try { await uploadRef.current.abort(); } catch (e) {}
      uploadRef.current = null;
    }
    const id = uploadVideoIdRef.current;
    uploadVideoIdRef.current = null;
    setUploading(false);
    setUploadError(false);
    setUploadPct(0);
    if (id) {
      await fetch('/api/admin/videos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      await fetchVideos().catch(() => {});
    }
  }

  async function removeVideo(v) {
    if (!confirm(`Delete "${v.title || 'Untitled'}"? This permanently removes it from bunny.net.`)) return;
    const res = await fetch('/api/admin/videos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Failed to delete');
      return;
    }
    setVideos((prev) => prev.filter((x) => x.id !== v.id));
  }

  function onDropFile(e) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('video/')) { alert('Please drop a video file.'); return; }
    setUploadFile(f);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function addViewer() {
    if (!newViewerEmail.trim()) return;
    await fetch('/api/admin/viewers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newViewerEmail }),
    });
    setNewViewerEmail('');
    const r = await fetch('/api/admin/viewers');
    setViewers(await r.json());
  }

  async function removeViewer(email) {
    await fetch('/api/admin/viewers', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setViewers((prev) => prev.filter((v) => v.email !== email));
  }

  async function addBulkViewers() {
    const text = bulkEmails.trim();
    if (!text) return;
    const res = await fetch('/api/admin/viewers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to add viewers'); return; }
    setBulkEmails('');
    const r = await fetch('/api/admin/viewers');
    setViewers(await r.json());
  }

  function startRename(v) { setEditingId(v.id); setEditTitle(v.title || ''); }
  function cancelRename() { setEditingId(null); setEditTitle(''); }

  async function saveRename(v) {
    const title = editTitle.trim();
    if (!title) return;
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, title }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Rename failed');
      return;
    }
    setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, title } : x)));
    cancelRename();
  }

  async function addCollection() {
    const name = newCollection.trim();
    if (!name) return;
    const res = await fetch('/api/admin/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to create collection'); return; }
    setNewCollection('');
    setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function removeCollection(id) {
    if (!confirm('Delete this collection? Videos stay, but become uncategorized.')) return;
    const res = await fetch('/api/admin/collections', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete'); return; }
    setCollections((prev) => prev.filter((c) => c.id !== id));
    setVideos((prev) => prev.map((v) => (v.collectionId === id ? { ...v, collectionId: '' } : v)));
  }

  async function assignCollection(v, collectionId) {
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, collectionId }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to update'); return; }
    setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, collectionId } : x)));
  }

  function onDragStartRow(e, id) { dragIdRef.current = id; e.dataTransfer.effectAllowed = 'move'; }
  function onDragOverRow(e, id) { e.preventDefault(); if (id !== dragOverId) setDragOverId(id); }
  function onDragEndRow() { dragIdRef.current = null; setDragOverId(null); }

  function onDropRow(e, id) {
    e.preventDefault();
    const fromId = dragIdRef.current;
    dragIdRef.current = null;
    setDragOverId(null);
    if (!fromId || fromId === id) return;
    const from = videos.findIndex((v) => v.id === fromId);
    const to = videos.findIndex((v) => v.id === id);
    if (from < 0 || to < 0) return;
    const next = [...videos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setVideos(next);
    saveOrder(next.map((v) => v.id));
  }

  async function refreshShares() {
    const r = await fetch('/api/admin/shares');
    setActiveShares(await r.json());
  }

  async function revokeShare(shareId) {
    await fetch('/api/admin/shares', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId }),
    });
    setActiveShares((prev) => prev.filter((s) => s.shareId !== shareId));
  }

  async function handleShare(video) {
    const email = (emails[video.id] || '').trim();
    if (!email) return alert("Enter the recipient's email first");
    const hours = parseInt(expiresHours[video.id]) || 72;
    const res = await fetch('/api/admin/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: video.id, title: video.title, email, expiresInHours: hours }),
    });
    const data = await res.json();
    setShareLinks((prev) => ({ ...prev, [video.id]: data.watchUrl }));
    refreshShares();
  }

  async function saveVideoCount() {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: videoCount }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || `Failed to save (status ${res.status})`); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveOrder(idList) {
    await fetch('/api/admin/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: idList }),
    });
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  // Bunny video status: 0–3 still encoding, 4 finished, 5/6 failed.
  function videoStatusBadge(v) {
    if (typeof v.status !== 'number') return null;
    if (v.status === 5 || v.status === 6) {
      return <span className="badge badge-error">Failed</span>;
    }
    if (v.status >= 4) return null;
    return <span className="badge badge-processing">Processing {v.encodeProgress || 0}%</span>;
  }

  if (isLoading) {
    return (
      <AppShell isAdmin>
        <p className="text-muted">Loading…</p>
      </AppShell>
    );
  }

  if (!user) {
    return (
      <AppShell>
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center' }}>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>You need to be signed in.</p>
          <a href="/api/auth/login" className="btn btn-primary btn-sm">Sign in</a>
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <div className="card" style={{ padding: '1.5rem' }}>
          <p className="text-muted">{error}</p>
        </div>
      </AppShell>
    );
  }

  const q = videoQuery.trim().toLowerCase();
  const shownVideos = q ? videos.filter((v) => (v.title || '').toLowerCase().includes(q)) : videos;

  return (
    <AppShell isAdmin>
      <div className="admin-topbar">
        <h1 className="admin-page-title">Admin</h1>
        <nav className="admin-tabs">
          {[
            { id: 'videos', label: 'Videos', count: videos.length },
            { id: 'viewers', label: 'Viewers', count: viewers.length },
            { id: 'shares', label: 'Shares', count: activeShares.length },
            { id: 'settings', label: 'Settings', count: null },
            { id: 'activity', label: 'Activity', count: null },
            { id: 'analytics', label: 'Analytics', count: null },
          ].map((t) => (
            <button
              key={t.id}
              className={`admin-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="tab-count">{t.count}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="admin-stack">

        {tab === 'settings' && (
        <>
        {/* Appearance */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Appearance</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Choose the accent palette used across the portal for every visitor.
          </p>

          <div className="theme-preview" />

          <div className="preset-grid">
            {PRESETS.map((p) => {
              const active = theme.accent1 === p.accent1 && theme.accent2 === p.accent2;
              return (
                <button
                  key={p.name}
                  className="preset-btn"
                  data-active={active}
                  onClick={() => previewTheme({ accent1: p.accent1, accent2: p.accent2 })}
                >
                  <span
                    className="preset-swatch"
                    style={{ background: `linear-gradient(135deg, ${p.accent1}, ${p.accent2})` }}
                  />
                  {p.name}
                </button>
              );
            })}
          </div>

          <div className="color-fields">
            <div className="color-field">
              <label className="label">Accent 1</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  className="color-swatch"
                  value={theme.accent1}
                  onChange={(e) => setAccent('accent1', e.target.value)}
                />
                <input
                  type="text"
                  className="input input-sm color-hex"
                  value={theme.accent1}
                  onChange={(e) => setAccent('accent1', e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="color-field">
              <label className="label">Accent 2</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  className="color-swatch"
                  value={theme.accent2}
                  onChange={(e) => setAccent('accent2', e.target.value)}
                />
                <input
                  type="text"
                  className="input input-sm color-hex"
                  value={theme.accent2}
                  onChange={(e) => setAccent('accent2', e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>

            <button onClick={saveTheme} className="btn btn-primary btn-sm">
              {themeSaved ? 'Saved!' : 'Save palette'}
            </button>
          </div>
        </div>

        {/* Homepage settings */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Homepage Settings</h2>
          <div className="admin-row">
            <label className="label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>
              Videos shown:
            </label>
            <input
              type="number"
              min="1"
              max="1000"
              value={videoCount}
              onChange={(e) => setVideoCount(e.target.value)}
              className="input input-sm"
              style={{ width: '5rem', flex: 'none' }}
            />
            <button onClick={saveVideoCount} className="btn btn-primary btn-sm">
              {saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        {/* Content protection */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Content Protection</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            How this portal keeps videos private.
          </p>
          <ul className="protection-list">
            <li>
              <span className="dot dot-ok" />
              Every play uses a fresh signed, time-limited token — never a public URL.
            </li>
            <li>
              <span className="dot dot-ok" />
              Share links require login and an email match before the video plays.
            </li>
            <li>
              <span className="dot dot-warn" />
              Direct bunny.net CDN file URLs stay public unless you enable{' '}
              <strong>Block Direct URL File Access</strong> in your bunny.net library&rsquo;s Security
              settings. This app never exposes those URLs, but enabling it closes the gap for anyone
              who obtains one.
            </li>
          </ul>
          <a
            className="btn btn-outline btn-sm"
            href="https://dash.bunny.net/stream"
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 14 }}
          >
            Open bunny.net dashboard
          </a>
        </div>
        </>
        )}

        {tab === 'viewers' && (
        <>
        {/* Approved viewers */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Approved Viewers</h2>
          <div className="admin-row">
            <input
              type="email"
              placeholder="viewer@example.com"
              value={newViewerEmail}
              onChange={(e) => setNewViewerEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addViewer()}
              className="input input-sm"
            />
            <button onClick={addViewer} className="btn btn-primary btn-sm">Add</button>
          </div>

          <details className="bulk-add">
            <summary>Bulk add several at once</summary>
            <textarea
              className="input"
              rows={4}
              placeholder="Paste emails separated by commas, spaces, or new lines"
              value={bulkEmails}
              onChange={(e) => setBulkEmails(e.target.value)}
            />
            <button onClick={addBulkViewers} className="btn btn-primary btn-sm" style={{ marginTop: 10 }}>
              Add all
            </button>
          </details>

          {viewers.length > 0 ? (
            <ul className="viewer-list">
              {viewers.map((v) => (
                <li key={v.email} className="viewer-item">
                  <span className="viewer-email">{v.email}</span>
                  <span className="viewer-seen">{v.lastSeen ? `seen ${timeAgo(v.lastSeen)}` : 'never seen'}</span>
                  <button
                    onClick={() => removeViewer(v.email)}
                    className="btn btn-icon"
                    title="Remove viewer"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mt-4">No approved viewers yet.</p>
          )}
        </div>
        </>
        )}

        {tab === 'shares' && (
        <>
        {/* Active share links */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Active Private Links</h2>
          {activeShares.length === 0 ? (
            <p className="text-muted">No active links.</p>
          ) : (
            <ul className="shares-list">
              {activeShares.map((s) => (
                <li key={s.shareId} className="share-item">
                  <div className="share-info">
                    <span className="share-title">
                      {s.title}
                      {s.viewedAt
                        ? <span className="badge badge-ok">Viewed</span>
                        : <span className="badge badge-muted">Not viewed</span>}
                    </span>
                    <span className="share-meta">
                      {s.email} &mdash; expires {new Date(s.expiresAt).toLocaleString()}
                      {s.viewedAt ? ` · viewed ${timeAgo(s.viewedAt)}` : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => revokeShare(s.shareId)}
                    className="btn btn-destructive btn-sm"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        </>
        )}

        {tab === 'videos' && (
        <>
        {/* Upload video */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Upload Video</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Upload a new video straight to bunny.net. It appears in the library below once processing finishes.
          </p>

          <div
            className={`dropzone${dragOver ? ' drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragOver(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
            onDrop={onDropFile}
          >
            <p className="dropzone-hint">
              {uploadFile ? (
                <>Selected: <span className="font-medium">{uploadFile.name}</span></>
              ) : (
                <>Drag &amp; drop a video here, or pick a file below</>
              )}
            </p>

            <div className="upload-controls">
              <input
                type="text"
                placeholder="Title (optional — defaults to file name)"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                className="input input-sm"
                disabled={uploading}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="file-input"
                disabled={uploading}
              />
              <button
                onClick={beginUpload}
                className="btn btn-primary btn-sm"
                disabled={!uploadFile || uploading}
              >
                {uploading ? `Uploading ${uploadPct}%` : 'Upload'}
              </button>
            </div>

            {uploading && (
              <div className="upload-status">
                <div className="progress" aria-label="Upload progress">
                  <div className="progress-bar" style={{ width: `${uploadPct}%` }} />
                </div>
                <button onClick={cancelUpload} className="btn btn-outline btn-sm">Cancel</button>
              </div>
            )}

            {uploadError && !uploading && (
              <div className="upload-status upload-failed">
                <span className="badge badge-error">Failed</span>
                {uploadErrorMsg && <span className="upload-error-msg">{uploadErrorMsg}</span>}
                <button onClick={retryUpload} className="btn btn-primary btn-sm">Retry</button>
                <button onClick={cancelUpload} className="btn btn-ghost btn-sm">Discard</button>
              </div>
            )}
          </div>
        </div>

        {/* Collections */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Collections</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Group videos into categories. Viewers can filter the homepage by collection.
          </p>
          <div className="admin-row">
            <input
              className="input input-sm"
              placeholder="New collection name"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCollection()}
            />
            <button onClick={addCollection} className="btn btn-primary btn-sm">Add</button>
          </div>
          {collections.length > 0 && (
            <ul className="viewer-list">
              {collections.map((c) => (
                <li key={c.id} className="viewer-item">
                  <span className="viewer-email">{c.name}</span>
                  <span className="viewer-seen">{c.videoCount ?? 0} videos</span>
                  <button
                    onClick={() => removeCollection(c.id)}
                    className="btn btn-icon"
                    title="Delete collection"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Video library */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Video Library</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Drag the handle to set the order videos appear on the homepage.
          </p>

          <div className="search-box">
            <IconSearch className="search-icon" />
            <input
              className="input input-sm"
              placeholder="Search videos…"
              value={videoQuery}
              onChange={(e) => setVideoQuery(e.target.value)}
            />
            {videoQuery && (
              <button className="btn btn-icon" onClick={() => setVideoQuery('')} title="Clear search">
                <IconX />
              </button>
            )}
          </div>

          {shownVideos.length === 0 ? (
            <p className="text-muted mt-4">
              {videoQuery ? 'No videos match your search.' : 'No videos yet.'}
            </p>
          ) : (
          <ul className="admin-video-list">
            {shownVideos.map((v) => (
              <li
                key={v.id}
                className={`admin-video-item${dragOverId === v.id ? ' drag-over' : ''}`}
                onDragOver={!q ? (e) => onDragOverRow(e, v.id) : undefined}
                onDrop={!q ? (e) => onDropRow(e, v.id) : undefined}
              >
                <div className="admin-video-header">
                  {v.thumbnail && (
                    <img
                      className="admin-video-thumb"
                      src={v.thumbnail}
                      alt=""
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  )}
                  <span
                    className="drag-handle"
                    draggable={!q}
                    onDragStart={(e) => onDragStartRow(e, v.id)}
                    onDragEnd={onDragEndRow}
                    title={q ? 'Clear search to reorder' : 'Drag to reorder'}
                  >
                    <IconGrip />
                  </span>

                  {editingId === v.id ? (
                    <>
                      <input
                        className="input input-sm"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(v);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <button onClick={() => saveRename(v)} className="btn btn-icon" title="Save">
                        <IconCheck />
                      </button>
                      <button onClick={cancelRename} className="btn btn-icon" title="Cancel">
                        <IconX />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="admin-video-title">{v.title}</span>
                      {videoStatusBadge(v)}
                      <button onClick={() => startRename(v)} className="btn btn-icon" title="Rename">
                        <IconPencil />
                      </button>
                      <button
                        onClick={() => removeVideo(v)}
                        className="btn btn-icon"
                        title="Delete video"
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </div>

                {collections.length > 0 && (
                  <div className="admin-video-collection">
                    <label className="collection-label">Collection</label>
                    <select
                      className="input input-sm"
                      value={v.collectionId || ''}
                      onChange={(e) => assignCollection(v, e.target.value)}
                    >
                      <option value="">No collection</option>
                      {collections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="admin-video-share">
                  <input
                    type="email"
                    placeholder="recipient@example.com"
                    value={emails[v.id] || ''}
                    onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    className="input input-sm"
                  />
                  <input
                    type="number"
                    placeholder="72h"
                    min="1"
                    max="720"
                    value={expiresHours[v.id] || ''}
                    onChange={(e) => setExpiresHours((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    className="input input-sm"
                    style={{ width: '5rem', flex: 'none' }}
                    title="Hours until link expires"
                  />
                  <button onClick={() => handleShare(v)} className="btn btn-outline btn-sm">
                    Create link
                  </button>
                </div>

                {shareLinks[v.id] && (
                  <div className="share-result">
                    <input
                      className="input input-sm"
                      readOnly
                      value={shareLinks[v.id]}
                    />
                    <button
                      onClick={() => copyLink(shareLinks[v.id])}
                      className="btn btn-icon"
                      title="Copy link"
                    >
                      <IconCopy />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          )}
        </div>
        </>
        )}

        {tab === 'activity' && (
        <>
        {/* Activity log */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Activity Log</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            The 100 most recent admin actions.
          </p>
          {audit.length === 0 ? (
            <p className="text-muted">No recorded activity yet.</p>
          ) : (
            <ul className="audit-list">
              {audit.map((a, i) => (
                <li key={i} className="audit-item">
                  <span className="audit-action">{a.action}</span>
                  {a.detail && <span className="audit-detail">{a.detail}</span>}
                  <span className="audit-meta">{a.actor} · {timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </>
        )}

        {tab === 'analytics' && (
        <>
        {/* Analytics */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Analytics</h2>
          {!analytics ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <div className="stat-grid">
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.totalViews)}</span>
                  <span className="stat-label">Total views</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.last30Views)}</span>
                  <span className="stat-label">Views · 30 days</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{analytics.totalWatchHours}h</span>
                  <span className="stat-label">Watch time</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.videoCount)}</span>
                  <span className="stat-label">Videos</span>
                </div>
              </div>

              {analytics.chart && analytics.chart.length > 0 && (
                <div className="analytics-chart">
                  <div className="chart-heading">Views · last 30 days</div>
                  <div className="chart-bars">
                    {(() => {
                      const max = Math.max(...analytics.chart.map((d) => d.count), 1);
                      return analytics.chart.map((d) => (
                        <span
                          key={d.date}
                          className="chart-bar"
                          style={{ height: `${Math.max(2, Math.round((d.count / max) * 100))}%` }}
                          title={`${d.date}: ${d.count} views`}
                        />
                      ));
                    })()}
                  </div>
                </div>
              )}

              <h3 className="analytics-subhead">Most watched</h3>
              {analytics.topVideos.length === 0 ? (
                <p className="text-muted">No views recorded yet.</p>
              ) : (
                <ul className="analytics-list">
                  {analytics.topVideos.map((v) => (
                    <li key={v.id} className="analytics-row">
                      <span className="analytics-title">{v.title}</span>
                      {v.length > 0 && <span className="analytics-dur">{formatDuration(v.length)}</span>}
                      <span className="analytics-views">{formatNumber(v.views)} views</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        </>
        )}

      </div>
    </AppShell>
  );
}
