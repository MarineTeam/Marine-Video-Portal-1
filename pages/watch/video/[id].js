import { useCallback, useState } from 'react';
import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { listVideos, getEmbedUrl } from '../../../lib/bunny';
import { isStaffUser } from '../../../lib/roles';
import { resolveAccess, canSeeVideo } from '../../../lib/groups';
import { getSchedule, isVisibleFor } from '../../../lib/schedule';
import { getVideoMeta } from '../../../lib/videoMetaStore';
import { formatTimestamp } from '../../../lib/videoMeta';
import { isVerified } from '../../../lib/verification';
import { isGeoAllowed } from '../../../lib/geo';
import { getGlobalWatermark, getVideoWatermarkMode, isWatermarkExempt, resolveWatermark } from '../../../lib/watermark';
import AppShell from '../../../components/AppShell';
import ResumablePlayer from '../../../components/ResumablePlayer';
import TranscriptPanel from '../../../components/TranscriptPanel';
import SaveToListButton from '../../../components/SaveToListButton';
import RatingButtons from '../../../components/RatingButtons';
import Comments from '../../../components/Comments';
import { getMyList } from '../../../lib/mylistStore';
import { isSaved } from '../../../lib/mylist';
import { getRatings } from '../../../lib/ratingsStore';
import { ratingOf } from '../../../lib/ratings';
import { parseTimeParam } from '../../../lib/timestampLink';
import { compareReferences, formatReference, parseReferences } from '../../../lib/scripture';
import { passageSearchHref } from '../../../lib/searchLink';
import { IconChevronLeft } from '../../../components/icons';
import { withMonitorPage } from '../../../lib/monitor';

async function getServerSidePropsInner({ req, res, params, query }) {
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
  if (!staff && !isVisibleFor(await getSchedule(video.guid), access.groupIds)) {
    return { props: { error: 'This video is not currently available.', adminUser: staff } };
  }

  const meta = await getVideoMeta(video.guid);
  // Read server-side so the toggle never paints 'Save' on a video already
  // saved. getMyList swallows read failures into {}, so an unreadable list
  // starts it unsaved — which one click corrects.
  const saved = isSaved(await getMyList(email), video.guid);
  // Same posture: getRatings swallows read failures, so an unreadable rating
  // starts the buttons unpressed rather than failing a page the viewer is
  // entitled to.
  const vote = ratingOf(await getRatings(email), video.guid);

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
      chapters: meta?.chapters || [],
      saved,
      vote,
      // Null when there is no ?t=, or when it is not a timestamp we accept.
      // Null rather than 0 on purpose: an unparseable value must leave the
      // saved resume position alone rather than restarting the video.
      startAt: parseTimeParam(query?.t),
      notes: meta?.notes || '',
    },
  };
}

export const getServerSideProps = withMonitorPage(getServerSidePropsInner);

export default function WatchVideo({ embedUrl, title, videoId, error, adminUser, watermarkText, chapters = [], notes = '', saved = false, vote = null, startAt = null }) {
  const passages = error ? [] : parseReferences(`${title || ''}\n${notes || ''}`).sort(compareReferences);
  // Set once player.js attaches. Until then (and forever, if it fails to load)
  // chapters render as plain text rather than buttons that would do nothing.
  const [seek, setSeek] = useState(null);
  // Stable identity so ResumablePlayer's effect doesn't re-run each render.
  const handleSeekAvailable = useCallback((fn) => setSeek(() => fn), []);
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
          <div className="watch-head">
            <h1 className="watch-title">{title}</h1>
            <SaveToListButton videoId={videoId} initialSaved={saved} />
            <RatingButtons videoId={videoId} initialVote={vote} />
          </div>
          <ResumablePlayer
            embedUrl={embedUrl}
            title={title}
            videoId={videoId}
            watermarkText={watermarkText}
            onSeekAvailable={handleSeekAvailable}
            startAt={startAt}
          />

          {chapters.length > 0 && (
            <section className="chapters">
              <h2 className="chapters-title">Chapters</h2>
              <ul className="chapter-list">
                {chapters.map((c) => (
                  <li key={`${c.seconds}-${c.label}`}>
                    {seek ? (
                      <button type="button" className="chapter-row" onClick={() => seek(c.seconds)}>
                        <span className="chapter-time">{formatTimestamp(c.seconds)}</span>
                        <span className="chapter-label">{c.label}</span>
                      </button>
                    ) : (
                      <span className="chapter-row chapter-row--static">
                        <span className="chapter-time">{formatTimestamp(c.seconds)}</span>
                        <span className="chapter-label">{c.label}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Same seek and the same degradation as the chapter list above. The
              panel fetches itself lazily, so a video nobody expands - and a
              video that was never transcribed - costs nothing here. */}
          <TranscriptPanel videoId={videoId} seekable={Boolean(seek)} onSeek={seek} />

          {notes && (
            <section className="video-notes">
              <h2 className="chapters-title">Notes</h2>
              <p className="video-notes-body">{notes}</p>
            </section>
          )}

          {/* The passages the title and notes cite, each opening the library
              searched for it — the ordinary gated search, so a link can
              never show a viewer something new. Read from the title too,
              because /api/videos passage-matches titles in this repo. */}
          {passages.length > 0 && (
            <nav className="passages" aria-label="Passages in this video">
              <span className="passages-label">Passages</span>
              <div className="passage-chips">
                {passages.map((ref) => {
                  const label = formatReference(ref);
                  return (
                    <a key={label} href={passageSearchHref(label)} className="chip passage-chip">
                      {label}
                    </a>
                  );
                })}
              </div>
            </nav>
          )}

          <Comments videoId={videoId} />
        </>
      )}
    </AppShell>
  );
}
