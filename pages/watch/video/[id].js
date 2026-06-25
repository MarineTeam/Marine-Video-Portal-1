import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';

function isAdmin(email) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return admins.includes(email);
}

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
  const approved = await redis.sismember('approved_viewers', email);

  if (!approved && !isAdmin(email)) {
    return { props: { error: 'Your account is not approved to view this content.' } };
  }

  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === params.id);

  if (!video) {
    return { props: { error: 'Video not found.' } };
  }

  return {
    props: {
      embedUrl: getEmbedUrl(video.guid, 3600),
      title: video.title,
    },
  };
}

export default function WatchVideo({ embedUrl, title, error }) {
  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <p>{error}</p>
        <a href="/">Back home</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <a href="/">&larr; Back to videos</a>
      <h1>{title}</h1>
      <iframe src={embedUrl} width="640" height="360" allow="fullscreen" frameBorder="0" title={title} />
    </div>
  );
}
