import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [viewers, setViewers] = useState([]);
  const [newViewerEmail, setNewViewerEmail] = useState('');
  const [videoCount, setVideoCount] = useState(2);
  const [expiresHours, setExpiresHours] = useState({});
  const [activeShares, setActiveShares] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return;

    fetch('/api/admin/videos')
      .then((r) => {
        if (!r.ok) throw new Error('Forbidden — this account is not an admin');
        return r.json();
      })
      .then(setVideos)
      .catch((e) => setError(e.message));

    fetch('/api/admin/viewers')
      .then((r) => r.json())
      .then(setViewers);

    fetch('/api/admin/settings')
      .then((r) => r.json())
      .then((d) => setVideoCount(d.count));
  }, [user]);

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
  }

  

  async function saveVideoCount() {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: videoCount }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data.error || `Failed to save (status ${res.status})`);
      return;
    }

    alert('Saved');
  }

  async function saveOrder(idList) {
    await fetch('/api/admin/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: idList }),
    });
  }

  function moveVideo(index, direction) {
    const newVideos = [...videos];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newVideos.length) return;
    [newVideos[index], newVideos[targetIndex]] = [newVideos[targetIndex], newVideos[index]];
    setVideos(newVideos);
    saveOrder(newVideos.map((v) => v.id));
  }

  if (isLoading) return <p>Loading...</p>;
  if (!user) return <a href="/api/auth/login">Log in</a>;
  if (error) return <p>{error}</p>;

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Admin</h1>
      <a href="/api/auth/logout">Log out</a>

      <h2>Homepage Settings</h2>
      <label>
        Number of videos shown on homepage:{' '}
        <input
          type="number"
          min="1"
          max="200"
          value={videoCount}
          onChange={(e) => setVideoCount(e.target.value)}
          style={{ width: 60 }}
        />
      </label>
      <button onClick={saveVideoCount} style={{ marginLeft: 8 }}>
        Save
      </button>

      <h2>Approved Viewers (can see homepage videos)</h2>
      <input
        type="email"
        placeholder="viewer@example.com"
        value={newViewerEmail}
        onChange={(e) => setNewViewerEmail(e.target.value)}
        style={{ width: 240, marginRight: 8 }}
      />
      <button onClick={addViewer}>Add</button>
      <ul>
        {viewers.map((email) => (
          <li key={email}>
            {email} <button onClick={() => removeViewer(email)}>Remove</button>
          </li>
        ))}
      </ul>

      <h2>Video Library</h2>
      <p style={{ color: '#666' }}>Use the arrows to set the order videos appear in on the homepage.</p>
      <ul>
        {videos.map((v, i) => (
          <li key={v.id} style={{ marginBottom: 20 }}>
            <button onClick={() => moveVideo(i, -1)} disabled={i === 0}>
              ↑
            </button>
            <button onClick={() => moveVideo(i, 1)} disabled={i === videos.length - 1} style={{ marginRight: 8 }}>
              ↓
            </button>
            <strong>{v.title}</strong>
            <br />
            <input
              type="email"
              placeholder="recipient@example.com"
              value={emails[v.id] || ''}
              onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
              style={{ width: 240, marginRight: 8 }}
            />
            <input
              type="number"
              placeholder="72"
              min="1"
              max="720"
              value={expiresHours[v.id] || ''}
              onChange={(e) => setExpiresHours((prev) => ({ ...prev, [v.id]: e.target.value }))}
              style={{ width: 70, marginRight: 8 }}
              title="Hours until link expires"
            />              
            <button onClick={() => handleShare(v)}>Create private link</button>
            {shareLinks[v.id] && (
              <div style={{ marginTop: 4 }}>
                <input style={{ width: 420 }} readOnly value={shareLinks[v.id]} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
