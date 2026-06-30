import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';
import { isAdmin } from '../../../lib/auth';

export async function getServerSideProps({ req, res, params }) {
  const session = await getSession(req, res);
  if (!session) return { redirect: { destination: `/api/auth/login?returnTo=/watch/video/${params.id}`, permanent: false } };
  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);
  if (!approved && !isAdmin(email)) return { props: { error: 'Your account is not approved to view this content.' } };
  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === params.id);
  if (!video) return { props: { error: 'Video not found.' } };
  return { props: { embedUrl: getEmbedUrl(video.guid, 3600), title: video.title } };
}

export default function WatchVideo({ embedUrl, title, error }) {
  return (
    <>
      <style>{`*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{background:#1a1e2e;color:#f2f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}.shell{min-height:100vh}.header{background:rgba(30,36,56,0.8);backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,0.1);position:sticky;top:0;z-index:10}.header-inner{max-width:960px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}.logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;color:#f2f4f8;text-decoration:none}.main{max-width:960px;margin:0 auto;padding:40px 24px}.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:0.625rem;font-size:13px;font-weight:500;cursor:pointer;border:none;transition:opacity 0.15s;line-height:1;text-decoration:none}.btn-ghost{background:transparent;color:#f2f4f8}.btn-ghost:hover{background:#252c40}.iframe-wrap{border-radius:0.625rem;overflow:hidden;background:#000;aspect-ratio:16/9}.iframe-wrap iframe{width:100%;height:100%;display:block;border:0}`}</style>
      <div className="shell">
        <header className="header">
          <div className="header-inner">
            <a href="/" className="logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5eafc6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 19.5C2.5 19.5 5 17 8 17s5.5 2 8.5 2 5.5-2.5 5.5-2.5V4.5S19.5 7 16.5 7 11 5 8 5 2.5 7.5 2.5 7.5V19.5z"/><line x1="12" y1="5" x2="12" y2="19"/></svg>
              Marine Video Portal
            </a>
          </div>
        </header>
        <main className="main">
          {error ? (
            <div>
              <p style={{ color: '#b0bac8', fontSize: 14 }}>{error}</p>
              <a href="/" className="btn btn-ghost" style={{ marginTop: 16 }}>← Back home</a>
            </div>
          ) : (
            <>
              <a href="/" className="btn btn-ghost" style={{ marginBottom: 20, marginLeft: -8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                Back to videos
              </a>
              <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>{title}</h1>
              <div className="iframe-wrap">
                <iframe src={embedUrl} allow="fullscreen" title={title} />
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
