import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Home() {
  const { user, isLoading } = useUser();
  const [data, setData] = useState({ videos: [], page: 1, totalPages: 1 });
  const [notApproved, setNotApproved] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!user) return;
    setNotApproved(false);
    fetch(`/api/videos?page=${page}`).then((r) => {
      if (r.status === 403) {
        setNotApproved(true);
        return;
      }
      r.json().then(setData);
    });
  }, [user, page]);

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
      <h2>Videos</h2>
      <ul>
        {data.videos.map((v) => (
          <li key={v.id} style={{ marginBottom: 8 }}>
            <a href={`/watch/video/${v.id}`}>{v.title}</a>
          </li>
        ))}
      </ul>

      {data.totalPages > 1 && (
        <div style={{ marginTop: 16 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span style={{ margin: '0 12px' }}>
            Page {data.page} of {data.totalPages}
          </span>
          <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
