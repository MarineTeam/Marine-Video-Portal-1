import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';
import { isAdmin } from '../../../lib/auth';
import { isGeoAllowed } from '../../../lib/geo';
import { getGlobalWatermark, getVideoWatermarkMode, isWatermarkExempt, resolveWatermark } from '../../../lib/watermark';
import AppShell from '../../../components/AppShell';
import ResumablePlayer from '../../../components/ResumablePlayer';
import { IconChevronLeft } from '../../../components/icons';
import { withMonitorPage } from '../../../lib/monitor';

async function getServerSidePropsInner({ req, res, params }) {
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

  // Admins have their own separate whitelist/toggle (plus a bypass-email
  // safety net) — see lib/geo.js. Both are off by default.
  if (!(await isGeoAllowed(req, email, isAdmin(email)))) {
    return { props: { error: 'This video is not available in your region.', adminUser: false } };
  }

  if (approved) await redis.hset(k('viewer_last_seen'), { [email]: Date.now() });

  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === params.id);

  if (!video) {
    return { props: { error: 'Video not found.', adminUser: isAdmin(email) } };
  }

  const [globalDefault, videoMode, exempt] = await Promise.all([
    getGlobalWatermark(),
    getVideoWatermarkMode(video.guid),
    isWatermarkExempt(email),
  ]);
  const watermark = resolveWatermark({ exempt, shareMode: undefined, videoMode, globalDefault });

  return {
    props: {
      embedUrl: getEmbedUrl(video.guid, 3600),
      title: video.title,
      videoId: video.guid,
      adminUser: isAdmin(email),
      watermarkText: watermark ? email : null,
    },
  };
}

export const getServerSideProps = withMonitorPage(getServerSidePropsInner);

export default function WatchVideo({ embedUrl, title, videoId, error, adminUser, watermarkText }) {
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
          <ResumablePlayer embedUrl={embedUrl} title={title} videoId={videoId} watermarkText={watermarkText} />
        </>
      )}
    </AppShell>
  );
}
