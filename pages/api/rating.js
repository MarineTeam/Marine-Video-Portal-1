import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser } from '../../lib/roles';
import { isVerified } from '../../lib/verification';
import { resolveAccess, canSeeVideo } from '../../lib/groups';
import { getSchedule, isVisibleNow } from '../../lib/schedule';
import { isGeoAllowed } from '../../lib/geo';
import { allow, callerId } from '../../lib/ratelimit';
import { listVideos } from '../../lib/bunny';
import { getRatings, recordRating } from '../../lib/ratingsStore';
import { normalizeVote, ratingOf } from '../../lib/ratings';
import { withMonitorApi } from '../../lib/monitor';

// The viewer's own rating of one video.
//
//   GET     ?videoId=...        -> { vote: 'up' | 'down' | null }
//   POST    { videoId, vote }   -> set it
//   DELETE  ?videoId=...        -> clear it
//
// Per-viewer data, so the email comes from the SESSION. This route takes no
// email parameter at all — a stronger guarantee than validating one, because
// there is no input that could name another person.
//
// RATING IS GATED LIKE WATCHING, with every check pages/watch/video/[id].js
// performs: approved or staff, region, **verified email**, group grants and
// the publish window — the same gate /api/mylist uses, and for the same
// reason: a successful write is itself an answer to "does this id exist?".
// The verified-email step has no counterpart in the sibling repos and is the
// one a port drops.
//
// TOTALS ARE NEVER RETURNED HERE. A viewer sees their own vote and nothing
// else; the counts are staff-only and served with the admin video list. See
// lib/ratings.js for why.
async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session?.user?.email) return res.status(401).json({ error: 'Not signed in' });
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

  // typeof, not coercion: String(['a','b']) would quietly become 'a,b', an id
  // nobody sent.
  const raw = req.method === 'POST' ? req.body?.videoId : req.query.videoId;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'videoId required' });
  }
  const videoId = raw.trim();

  if (req.method === 'GET') {
    return res.json({ vote: ratingOf(await getRatings(email), videoId) });
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    // A VIEWER write path — cheap per call, unbounded in aggregate, reachable
    // by anyone approved. The shared limiter is the right instrument (this
    // costs a Redis write, not money), unlike /api/admin/transcribe.
    if (!(await allow(callerId(req, session, 'rating')))) {
      return res.status(429).json({ error: 'Too many ratings — try again shortly' });
    }

    // Strict: 'up', 'down', or nothing. A DELETE clears, so there is no third
    // spelling of "no opinion" to get wrong.
    const next = req.method === 'DELETE' ? null : normalizeVote(req.body?.vote);
    if (req.method === 'POST' && !next) {
      return res.status(400).json({ error: 'Rating must be up or down' });
    }

    let video;
    try {
      const videos = await listVideos({ itemsPerPage: 100 });
      video = videos.find((v) => v.guid === videoId);
    } catch (e) {
      console.error('Could not load videos for a rating:', e);
      return res.status(502).json({ error: 'Could not save your rating' });
    }
    // 404, not 403, so a restricted viewer cannot probe which ids exist.
    if (!video) return res.status(404).json({ error: 'Not found' });

    const access = await resolveAccess(email, { staff });
    if (!canSeeVideo(access, video)) return res.status(404).json({ error: 'Not found' });

    if (!staff && !isVisibleNow(await getSchedule(video.guid))) {
      return res.status(404).json({ error: 'Not found' });
    }

    // One Redis script writes the vote and moves both counters, reading the
    // previous vote inside itself — so a repeated vote is a no-op, two racing
    // clicks cannot both count, and there is no second write left to fail
    // after the first succeeded. See lib/ratingScripts.js.
    const result = await recordRating(email, videoId, next);
    if (!result.ok) return res.status(502).json({ error: result.error });

    return res.json({ ok: true, vote: next });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
