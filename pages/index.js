import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Home() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [notApproved, setNotApproved] = useState(false);

  useEffect(() => {
    if (!user) return;
    fetch('/api/videos?limit=2').then((r) => {
      if (r.status === 403) {
        setNotApproved(true);
        return;
      }
      r.json().then(setVideos);
    });
  }, [user]);

  if (isLoading) return <p>Loading...</p>;

  if (!user) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Welcome</h1>
        <a href="/api/auth/login">Log in</a>
      </div>
    );
  }

  if (notApproved) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Hi, {user.name}</h1>
        <p>Your account hasn't been approved to view videos yet. Contact the administrator.</p>
        <a href="/api/auth/logout">Log out</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Hi, {user.name}</h1>
      <a href="/admin">Admin panel</a> | <a href="/api/auth/logout">Log out</a>
      <h2>Latest videos</h2>
      <div style={{ display: 'flex', gap: 16 }}>
        {videos.map((v) => (
          <div key={v.id}>
            <iframe src={v.embedUrl} width="320" height="180" allow="autoplay; fullscreen" frameBorder="0" title={v.title} />
            <p>{v.title}</p>
          </div>
        ))}
      </div>
    </div>
  );
}