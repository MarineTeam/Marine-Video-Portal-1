import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
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
  }, [user]);

  async function handleShare(video) {
    const email = (emails[video.id] || '').trim();
    if (!email) return alert('Enter the recipient\'s email first');

    const res = await fetch('/api/admin/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: video.id, title: video.title, email, expiresInHours: 72 }),
    });
    const data = await res.json();
    setShareLinks((prev) => ({ ...prev, [video.id]: data.watchUrl }));
  }

  if (isLoading) return <p>Loading...</p>;
  if (!user) return <a href="/api/auth/login">Log in</a>;
  if (error) return <p>{error}</p>;

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Admin — Video Library</h1>
      <a href="/api/auth/logout">Log out</a>
      <ul>
        {videos.map((v) => (
          <li key={v.id} style={{ marginBottom: 20 }}>
            <strong>{v.title}</strong>
            <br />
            <input
              type="email"
              placeholder="recipient@example.com"
              value={emails[v.id] || ''}
              onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
              style={{ width: 240, marginRight: 8 }}
            />
            <button onClick={() => handleShare(v)}>Create private link (72h)</button>
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