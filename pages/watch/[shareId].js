import { getSession } from '@auth0/nextjs-auth0';
import { getEmbedUrl } from '../../lib/bunny';
import { getShare, saveShare, isExpired } from '../../lib/shareBundle';
import AppShell from '../../components/AppShell';
import SharePlayer from '../../components/SharePlayer';
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

  const share = await getShare(params.shareId);

  // A record surviving past its logical expiry (grace period, so it can
  // still be extended) is not a valid watch — same generic message either way.
  if (!share || isExpired(share)) {
    return { props: { error: 'This link has expired or does not exist.' } };
  }

  if (share.email !== session.user.email.toLowerCase()) {
    return {
      props: {
        error: "This link isn't valid for your account. If you believe this is a mistake, contact the person who shared it with you.",
      },
    };
  }

  // Record every view (count + last-viewed).
  const now = Date.now();
  await saveShare(params.shareId, {
    ...share,
    viewedAt: share.viewedAt || now,
    views: (share.views || 0) + 1,
    lastViewedAt: now,
  });

  return {
    props: {
      embedUrl: getEmbedUrl(share.videoId, 3600),
      title: share.title || '',
      shareId: params.shareId,
    },
  };
}

export default function Watch({ embedUrl, title, shareId, error }) {
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
          <SharePlayer embedUrl={embedUrl} title={title} shareId={shareId} />
        </>
      )}
    </AppShell>
  );
}
