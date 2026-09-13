import { useCallback, useState } from 'react';
import { resolvePublicVideo } from '../../../lib/publicWatch';
import { formatTimestamp } from '../../../lib/videoMeta';
import AppShell from '../../../components/AppShell';
import ResumablePlayer from '../../../components/ResumablePlayer';
import { withMonitorPage } from '../../../lib/monitor';

// The ONLY route in this portal that serves a video without a session.
//
// It is a separate page on purpose. The obvious alternative — an "or public"
// branch inside pages/watch/video/[id].js — would mean the invite-only gate
// and the public path shared one file, and every future change to that file
// would have to re-reason about both. Keeping them apart means there is
// exactly one file to audit when asking "what can an anonymous visitor see?",
// and the answer is: one video, the one an admin explicitly ticked.
//
// What this page deliberately does NOT do:
//   - no search, no collection list, no video count, no navigation into the
//     library: nothing that reveals another video exists
//   - no progress tracking, no viewer_last_seen, no push subscription — all of
//     those are keyed by email and there is no email here
//   - no watermark, for the same reason (the watermark IS the viewer's email)
//   - no group resolution: groups narrow which VIEWERS see what, and an
//     anonymous visitor is not a viewer
//
// What it still honours: the publish/expiry window (a video scheduled for next
// Sunday must not leak early just because it is also public), the viewer geo
// whitelist, and signed time-limited embed tokens. "Public" means no login
// required — never an unsigned or permanent URL.
async function getServerSidePropsInner({ req, params }) {
  // The whole access decision is in lib/publicWatch.js so it can be tested
  // directly — see the header comment there for what this route deliberately
  // does not do (no search, no library listing, no per-viewer tracking, no
  // watermark, no group resolution).
  return { props: await resolvePublicVideo(req, params?.id) };
}

export const getServerSideProps = withMonitorPage(getServerSidePropsInner);

export default function PublicWatch({ embedUrl, title, videoId, error, chapters = [], notes = '' }) {
  const [seek, setSeek] = useState(null);
  const handleSeekAvailable = useCallback((fn) => setSeek(() => fn), []);

  return (
    <AppShell>
      {error ? (
        <div className="card watch-error">
          <p style={{ margin: 0 }}>This video isn&rsquo;t available.</p>
        </div>
      ) : (
        <>
          <h1 className="watch-title">{title}</h1>
          <ResumablePlayer
            embedUrl={embedUrl}
            title={title}
            videoId={videoId}
            watermarkText={null}
            trackProgress={false}
            onSeekAvailable={handleSeekAvailable}
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

          {notes && (
            <section className="video-notes">
              <h2 className="chapters-title">Notes</h2>
              <p className="video-notes-body">{notes}</p>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
