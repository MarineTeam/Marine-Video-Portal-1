import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isStaffUser } from '../../../lib/roles';
import { isVerified } from '../../../lib/verification';
import { resolveAccess, canSeeVideo } from '../../../lib/groups';
import { getSchedule, isVisibleNow } from '../../../lib/schedule';
import { isGeoAllowed } from '../../../lib/geo';
import { listVideos } from '../../../lib/bunny';
import { getTranscript, getTranscriptLanguages } from '../../../lib/captionsStore';
import { languageMissing, pickLanguage } from '../../../lib/captions';
import { withMonitorApi } from '../../../lib/monitor';

// One video's transcript, for the watch page.
//
// GUARDED EXACTLY LIKE pages/watch/video/[id].js, which is the whole point of
// this file. A transcript is the entire content of a private video in text
// form, so anything laxer than that page's gate is a way to READ a video you
// cannot WATCH. The checks mirror it in the same order:
//
//   1. signed in                     (getSession)
//   2. approved viewer or staff      (approved_viewers)
//   3. region                        (isGeoAllowed)
//   4. verified email                (isVerified)  <- this repo only
//   5. group grants                  (resolveAccess / canSeeVideo)
//   6. publish window, staff exempt  (isVisibleNow)
//
// Check 4 has no counterpart in the sibling repos and is easy to drop when
// porting; dropping it would let an unverified session read transcripts it
// cannot watch, which is precisely the gap the verification campaign exists
// to close.
//
// Checks 5 and 6 need the VIDEO, not just its id — canSeeVideo reads its
// collection — so this route resolves the video the same way the page does.
async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req, res);
  if (!session?.user?.email) return res.status(401).json({ error: 'Not signed in' });
  // Same derivation as pages/watch/video/[id].js — lowercase, nothing fancier.
  const email = session.user.email.toLowerCase();

  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return res.status(403).json({ error: 'Not approved' });

  if (!(await isGeoAllowed(req, email, staff))) {
    return res.status(403).json({ error: 'Not available in your region' });
  }
  if (!(await isVerified(session, { staff }))) {
    return res.status(403).json({ error: 'Please verify your email address' });
  }

  const videoId = typeof req.query.id === 'string' ? req.query.id : '';
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  let video;
  try {
    const videos = await listVideos({ itemsPerPage: 100 });
    video = videos.find((v) => v.guid === videoId);
  } catch (e) {
    console.error('Could not load videos for a transcript request:', e);
    return res.status(502).json({ error: 'Could not load the transcript' });
  }
  // 404, not 403: a viewer outside a group should not be able to probe which
  // ids exist by watching the status code change.
  if (!video) return res.status(404).json({ error: 'Not found' });

  const access = await resolveAccess(email, { staff });
  if (!canSeeVideo(access, video)) return res.status(404).json({ error: 'Not found' });

  if (!staff && !isVisibleNow(await getSchedule(video.guid))) {
    return res.status(404).json({ error: 'Not found' });
  }

  // An empty transcript is a normal answer, not an error: most videos have
  // never been transcribed. getTranscript already swallows read failures.
  const { default: fallback, all } = await getTranscriptLanguages(video.guid);
  const requested = typeof req.query.lang === 'string' ? req.query.lang.trim() : '';
  const language = pickLanguage(all, requested, fallback);
  // `missing` is reported rather than papered over: a viewer who picked
  // Spanish and is shown English would conclude the translation is WRONG,
  // which is worse than being told there isn't one.
  return res.json({
    cues: await getTranscript(video.guid, language),
    language,
    languages: all,
    missing: languageMissing(all, requested),
  });
}

export default withMonitorApi(handler);
