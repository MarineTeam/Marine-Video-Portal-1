import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { getEmbedUrl } from '../../lib/bunny';
import AppShell from '../../components/AppShell';
import { IconChevronLeft } from '../../components/icons';

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

  const share = await redis.get(k(`share:${params.shareId}`));

  if (!share) {
    return { props: { error: 'This link has expired or does not exist.' } };
  }

  if (share.email !== session.user.email.toLowerCase()) {
    return {
      props: {
        error: "This link isn't valid for your account. If you believe this is a mistake, contact the person who shared it with you.",
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
  return (
    <AppShell>
      <div className="watch-back">
        <a href="/" className="btn btn-ghost btn-sm">
          <IconChevronLeft />
          Back
        </a>
      </div>

      {error ? (
        <div className="card watch-error">
          <p style={{ margin: '0 0 1rem' }}>{error}</p>
          <a href="/api/auth/logout?returnTo=/" className="btn btn-outline btn-sm">
            Log out and try a different account
          </a>
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
