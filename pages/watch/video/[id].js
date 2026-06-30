import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';
import { isAdmin } from '../../../lib/auth';
import AppShell from '../../../components/AppShell';
import { IconChevronLeft } from '../../../components/icons';

export async function getServerSideProps({ req, res, params }) {
  const session = await getSession(req, res);

  if (!session) {
    return {
      redirect: {
        destination: `/api/auth/login?returnTo=/watch/video/${params.id}`,
        permanent: false,
      },
    };
  }

  const email = session.user.email.toLowerCase();
  const approved = await redis.sismember(k('approved_viewers'), email);

  if (!approved && !isAdmin(email)) {
    return { props: { error: 'Your account is not approved to view this content.', adminUser: false } };
  }

  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === params.id);

  if (!video) {
    return { props: { error: 'Video not found.', adminUser: isAdmin(email) } };
  }

  return {
    props: {
      embedUrl: getEmbedUrl(video.guid, 3600),
      title: video.title,
      adminUser: isAdmin(email),
    },
  };
}

export default function WatchVideo({ embedUrl, title, error, adminUser }) {
  return (
    <AppShell isAdmin={adminUser}>
      <div className="watch-back">
        <a href="/" className="btn btn-ghost btn-sm">
          <IconChevronLeft />
          Back to videos
        </a>
      </div>

      {error ? (
        <div className="card watch-error">
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      ) : (
        <>
          <h1 className="watch-title">{title}</h1>
          <div className="watch-player">
            <iframe src={embedUrl} allow="fullscreen" title={title} />
          </div>
        </>
      )}
    </AppShell>
  );
}
