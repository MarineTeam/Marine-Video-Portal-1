import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import { IconChevronUp, IconChevronDown, IconTrash, IconCopy } from '../components/icons';
import { applyTheme, DEFAULT_THEME, PRESETS, isValidHex } from '../lib/theme';

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
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [themeSaved, setThemeSaved] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!user) return;

    fetch('/api/admin/videos')
      .then((r) => {
        if (!r.ok) throw new Error('Forbidden — this account is not an admin');
        return r.json();
      })
      .then(setVideos)
      .catch((e) => setError(e.message));

    fetch('/api/admin/viewers').then((r) => r.json()).then(setViewers);
    fetch('/api/admin/settings').then((r) => r.json()).then((d) => setVideoCount(d.count));
    fetch('/api/admin/shares').then((r) => r.json()).then(setActiveShares);
    fetch('/api/theme').then((r) => r.json()).then(setTheme).catch(() => {});
  }, [user]);

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

  async function uploadVideo() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: uploadTitle.trim() || uploadFile.name }),
      });
      const meta = await res.json();
      if (!res.ok) throw new Error(meta.error || 'Failed to create video');

      const { Upload } = await import('tus-js-client');
      await new Promise((resolve, reject) => {
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
          onError: reject,
          onProgress: (sent, total) => setUploadPct(Math.round((sent / total) * 100)),
          onSuccess: resolve,
        });
        upload.start();
      });

      setUploadFile(null);
      setUploadTitle('');
      setUploadPct(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
      const r = await fetch('/api/admin/videos');
      setVideos(await r.json());
    } catch (e) {
      alert(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
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
    setViewers((prev) => prev.filter((e) => e !== email));
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

  function moveVideo(index, direction) {
    const next = [...videos];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setVideos(next);
    saveOrder(next.map((v) => v.id));
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).catch(() => {});
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

  return (
    <AppShell isAdmin>
      <div className="admin-stack">

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

          {viewers.length > 0 ? (
            <ul className="viewer-list">
              {viewers.map((email) => (
                <li key={email} className="viewer-item">
                  <span>{email}</span>
                  <button
                    onClick={() => removeViewer(email)}
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
                    <span className="share-title">{s.title}</span>
                    <span className="share-meta">
                      {s.email} &mdash; expires {new Date(s.expiresAt).toLocaleString()}
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

        {/* Upload video */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Upload Video</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Upload a new video straight to bunny.net. It appears in the library below once processing finishes.
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
              onClick={uploadVideo}
              className="btn btn-primary btn-sm"
              disabled={!uploadFile || uploading}
            >
              {uploading ? `Uploading ${uploadPct}%` : 'Upload'}
            </button>
          </div>

          {uploading && (
            <div className="progress" aria-label="Upload progress">
              <div className="progress-bar" style={{ width: `${uploadPct}%` }} />
            </div>
          )}
        </div>

        {/* Video library */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Video Library</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Use the arrows to set the order videos appear on the homepage.
          </p>
          <ul className="admin-video-list">
            {videos.map((v, i) => (
              <li key={v.id} className="admin-video-item">
                <div className="admin-video-header">
                  <div className="admin-video-controls">
                    <button
                      onClick={() => moveVideo(i, -1)}
                      disabled={i === 0}
                      className="btn btn-icon"
                      title="Move up"
                    >
                      <IconChevronUp />
                    </button>
                    <button
                      onClick={() => moveVideo(i, 1)}
                      disabled={i === videos.length - 1}
                      className="btn btn-icon"
                      title="Move down"
                    >
                      <IconChevronDown />
                    </button>
                  </div>
                  <span className="admin-video-title">{v.title}</span>
                </div>

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
        </div>

      </div>
    </AppShell>
  );
}
