import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../lib/redis';
import { getEmbedUrl } from '../../lib/bunny';

export async function getServerSideProps({ req, res, params }) {
  const session = await getSession(req, res);

  if (!session) {
    return {
      redirect: {
        destination: `/api/auth/login?returnTo=/watch/${params.shareId}`,
        permanent: false,
      },
    };
  }

  const share = await redis.get(`share:${params.shareId}`);

  if (!share) {
    return { props: { error: 'This link has expired or does not exist.' } };
  }

  if (share.email !== session.user.email.toLowerCase()) {
    return {
      props: {
        error: `This link was shared with ${share.email}. You're logged in as ${session.user.email}.`,
      },
    };
  }

  return {
    props: {
      embedUrl: getEmbedUrl(share.videoId, 3600),
      title: share.title || '',
    },
  };
}

export default function Watch({ embedUrl, title, error }) {
  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <p>{error}</p>
        <a href="/api/auth/logout?returnTo=/">Log out and try a different account</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>{title}</h1>
      <iframe
        src={embedUrl}
        width="640"
        height="360"
        allow="autoplay; fullscreen"
        frameBorder="0"
        title={title}
      />
    </div>
  );
}