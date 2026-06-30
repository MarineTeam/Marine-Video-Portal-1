import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import Layout from '../components/Layout';

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [expiresHours, setExpiresHours] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [activeShares, setActiveShares] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [newViewerEmail, setNewViewerEmail] = useState('');
  const [videoCount, setVideoCount] = useState(2);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return;
    fetch('/api/admin/videos')
      .then((r) => { if (!r.ok) throw new Error('Forbidden — this account is not an admin'); return r.json(); })
      .then(setVideos).catch((e) => setError(e.message));
    fetch('/api/admin/viewers').then((r) => r.json()).then(setViewers);
    fetch('/api/admin/settings').then((r) => r.json()).then((d) => setVideoCount(d.count));
    fetch('/api/admin/shares').then((r) => r.json()).then(setActiveShares);
  }, [user]);

  async function addViewer() {
    if (!newViewerEmail.trim()) return;
    await fetch('/api/admin/viewers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newViewerEmail }) });
    setNewViewerEmail('');
    fetch('/api/admin/viewers').then((r) => r.json()).then(setViewers);
  }

  async function removeViewer(email) {
    await fetch('/api/admin/viewers', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    setViewers((prev) => prev.filter((e) => e !== email));
  }

  async function refreshShares() {
    fetch('/api/admin/shares').then((r) => r.json()).then(setActiveShares);
  }

  async function revokeShare(shareId) {
    await fetch('/api/admin/shares', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId }) });
    setActiveShares((prev) => prev.filter((s) => s.shareId !== shareId));
  }

  async function handleShare(video) {
    const email = (emails[video.id] || '').trim();
    if (!email) return alert("Enter the recipient's email first");
    const hours = parseInt(expiresHours[video.id]) || 72;
    const res = await fetch('/api/admin/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: video.id, title: video.title, email, expiresInHours: hours }) });
    const data = await res.json();
    setShareLinks((prev) => ({ ...prev, [video.id]: data.watchUrl }));
    refreshShares();
  }

  async function copyLink(url) {
    await navigator.clipboard.writeText(url).catch(() => {});
  }

  async function saveVideoCount() {
    const res = await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: videoCount }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || `Failed to save (status ${res.status})`); return; }
    alert('Saved');
  }

  async function saveOrder(idList) {
    await fetch('/api/admin/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: idList }) });
  }

  function moveVideo(index, direction) {
    const newVideos = [...videos];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newVideos.length) return;
    [newVideos[index], newVideos[targetIndex]] = [newVideos[targetIndex], newVideos[index]];
    setVideos(newVideos);
    saveOrder(newVideos.map((v) => v.id));
  }

  if (isLoading) return <Layout user={null}><p className="muted text-sm">Loading…</p></Layout>;
  if (!user) return <Layout user={null}><div className="card card-center" style={{ maxWidth: 400, margin: '60px auto' }}><h1>Admin only</h1><p>Sign in with an admin account.</p><a href="/api/auth/login?returnTo=/admin" className="btn btn-primary">Sign in</a></div></Layout>;
  if (error) return <Layout user={user}><div className="card card-center" style={{ maxWidth: 400, margin: '60px auto' }}><h1>Access denied</h1><p>{error}</p></div></Layout>;

  return (
    <Layout user={user}>
      <h1 className="page-title">Admin</h1>

      {/* Homepage settings */}
      <div className="section">
        <h2>Homepage Settings</h2>
        <p className="section-desc">Number of videos shown on the homepage.</p>
        <div className="input-row" style={{ maxWidth: 320 }}>
          <input className="input number-input" type="number" min="1" max="1000" value={videoCount} onChange={(e) => setVideoCount(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={saveVideoCount}>Save</button>
        </div>
      </div>

      {/* Approved viewers */}
      <div className="section">
        <h2>Approved Viewers</h2>
        <p className="section-desc">These emails can see the homepage video list.</p>
        <div className="input-row" style={{ maxWidth: 480 }}>
          <input className="input" type="email" placeholder="viewer@example.com" value={newViewerEmail} onChange={(e) => setNewViewerEmail(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={addViewer}>Add</button>
        </div>
        {viewers.length === 0 ? (
          <p className="empty">No approved viewers yet.</p>
        ) : (
          <div className="card">
            {viewers.map((email) => (
              <div key={email} className="viewer-row">
                <span>{email}</span>
                <button className="btn btn-danger btn-sm" onClick={() => removeViewer(email)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active share links */}
      <div className="section">
        <h2>Active Private Links</h2>
        <p className="section-desc">All live share links — revoke any instantly.</p>
        {activeShares.length === 0 ? (
          <p className="empty muted text-sm">No active links.</p>
        ) : (
          <div className="card">
            {activeShares.map((s) => (
              <div key={s.shareId} className="share-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <strong>{s.title}</strong> → {s.email}
                    <div className="meta">Expires {new Date(s.expiresAt).toLocaleString()}</div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => revokeShare(s.shareId)}>Revoke</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Video library */}
      <div className="section">
        <h2>Video Library</h2>
        <p className="section-desc">Reorder with ↑↓, then create a private link for any video.</p>
        <div className="card">
          {videos.map((v, i) => (
            <div key={v.id} className="admin-video-row">
              <div className="order-btns">
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveVideo(i, -1)} disabled={i === 0}>↑</button>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveVideo(i, 1)} disabled={i === videos.length - 1}>↓</button>
              </div>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 8 }}>{v.title}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input className="input input-sm" type="email" placeholder="recipient@example.com" value={emails[v.id] || ''} onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))} style={{ width: 220 }} />
                  <input className="input input-sm number-input" type="number" placeholder="72" min="1" max="720" value={expiresHours[v.id] || ''} onChange={(e) => setExpiresHours((prev) => ({ ...prev, [v.id]: e.target.value }))} title="Hours until link expires" />
                  <button className="btn btn-primary btn-sm" onClick={() => handleShare(v)}>Create link</button>
                </div>
                {shareLinks[v.id] && (
                  <div className="share-url-row">
                    <input className="input input-sm" readOnly value={shareLinks[v.id]} />
                    <button className="btn btn-outline btn-sm" onClick={() => copyLink(shareLinks[v.id])}>Copy</button>
                  </div>
                )}
              </div>
              <div />
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
}
