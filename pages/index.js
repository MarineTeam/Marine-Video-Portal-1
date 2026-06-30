import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';
import Layout from '../components/Layout';

export default function Home() {
  const { user, isLoading } = useUser();
  const [data, setData] = useState({ videos: [], page: 1, totalPages: 1 });
  const [notApproved, setNotApproved] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!user) return;
    setNotApproved(false);
    fetch(`/api/videos?page=${page}`).then((r) => {
      if (r.status === 403) { setNotApproved(true); return; }
      r.json().then(setData);
    });
  }, [user, page]);

  if (isLoading) return <Layout user={null}><p className="muted text-sm">Loading…</p></Layout>;

  if (!user) {
    return (
      <Layout user={null}>
        <div className="card card-center" style={{ maxWidth: 480, margin: '60px auto' }}>
          <svg className="lock-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <h1>Sign in to continue</h1>
          <p>This portal is private. Approved viewers can sign in to access the video library.</p>
          <a href="/api/auth/login" className="btn btn-primary">Sign in</a>
        </div>
      </Layout>
    );
  }

  if (notApproved) {
    return (
      <Layout user={user}>
        <div className="card card-center" style={{ maxWidth: 480, margin: '60px auto' }}>
          <h1>Access pending</h1>
          <p><strong style={{ color: 'var(--fg)' }}>{user.email}</strong> isn&rsquo;t on the approved viewer list yet. Please ask the admin to add you.</p>
          <a href="/api/auth/logout" className="btn btn-outline">Sign out</a>
        </div>
      </Layout>
    );
  }

  return (
    <Layout user={user}>
      <h1 className="page-title">Videos</h1>
      {data.videos.length === 0 ? (
        <p className="muted text-sm">No videos available.</p>
      ) : (
        <div className="video-list">
          {data.videos.map((v) => (
            <a key={v.id} href={`/watch/video/${v.id}`} className="video-item">
              <span className="video-title">{v.title}</span>
              <span className="video-meta">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </span>
            </a>
          ))}
        </div>
      )}
      {data.totalPages > 1 && (
        <div className="pagination">
          <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span>Page {data.page} of {data.totalPages}</span>
          <button className="btn btn-outline btn-sm" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </Layout>
  );
}
