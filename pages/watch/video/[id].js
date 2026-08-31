import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';
import { isStaffUser } from '../../../lib/roles';
import { resolveAccess, canSeeVideo } from '../../../lib/groups';
import { getSchedule, isVisibleNow } from '../../../lib/schedule';
import { isVerified } from '../../../lib/verification';
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
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);

  if (!approved && !staff) {
    return { props: { error: 'Your account is not approved to view this content.', adminUser: false } };
  }

  // Admins have their own separate whitelist/toggle (plus a bypass-email
  // safety net) — see lib/geo.js. Both are off by default.
  if (!(await isGeoAllowed(req, email, staff))) {
    return { props: { error: 'This video is not available in your region.', adminUser: false } };
  }

  if (!(await isVerified(session, { staff }))) {
    return {
      props: {
        error: 'Please verify your email address before watching. Contact an admin if you need help.',
        adminUser: false,
      },
    };
  }

  if (approved) await redis.hset(k('viewer_last_seen'), { [email]: Date.now() });

  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === params.id);

  if (!video) {
    return { props: { error: 'Video not found.', adminUser: staff } };
  }

  // Group gating. This is the real boundary for direct-GUID access: the
  // homepage and search already hide videos outside a grouped viewer's
  // grants, and without this check they could still be opened by URL. Staff
  // and ungrouped viewers resolve to UNRESTRICTED and pass straight through.
  //
  // Share links are NOT affected — /watch/[shareId] is a separate route with
  // its own per-recipient token, so an admin can still share one video with
  // someone whose groups wouldn't otherwise show it.
  const access = await resolveAccess(email, { staff });
  if (!canSeeVideo(access, video)) {
    return { props: { error: "This video isn't available to your account.", adminUser: staff } };
  }

  // Scheduled publish/expiry — the direct-link half of the same gate applied
  // to the listing in /api/videos. Staff bypass so they can preview.
  if (!staff && !isVisibleNow(await getSchedule(video.guid))) {
    return { props: { error: 'This video is not currently available.', adminUser: staff } };
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
      adminUser: staff,
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
