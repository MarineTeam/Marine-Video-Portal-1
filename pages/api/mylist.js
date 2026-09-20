import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../lib/redis';
import { isStaffUser } from '../../lib/roles';
import { isVerified } from '../../lib/verification';
import { resolveAccess, canSeeVideo } from '../../lib/groups';
import { getSchedule, isVisibleNow } from '../../lib/schedule';
import { isGeoAllowed } from '../../lib/geo';
import { allow, callerId } from '../../lib/ratelimit';
import { listVideos } from '../../lib/bunny';
import { getMyList, removeFromMyList, saveToMyList } from '../../lib/mylistStore';
import { isFull, listIds, MAX_ITEMS } from '../../lib/mylist';
import { withMonitorApi } from '../../lib/monitor';

// The viewer's own saved queue.
//
//   GET     -> { ids: [...] }     saved video ids, newest saved first
//   POST    -> { videoId }        save one
//   DELETE  -> ?videoId=...       unsave one
//
// Per-viewer data, so the email comes from the SESSION. This route takes no
// email parameter at all — a stronger guarantee than validating one, because
// there is no input that could name another person.
//
// SAVING IS GATED LIKE WATCHING, with every check pages/watch/video/[id].js
// performs: approved or staff, region, **verified email**, group grants and
// the publish window. Without the gate a restricted viewer could pin an id
// they cannot see — it would be filtered from every read, but the write would
// have succeeded, and a 200 is itself an answer to "does this exist?".
//
// The verified-email step has no counterpart in the sibling repos and is the
// one a port drops. Group grants need the VIDEO (canSeeVideo reads its
// collection), so the route resolves it the way the page does.
//
// GET returns IDS ONLY, not video objects: the homepage already holds the
// library it is allowed to see, so intersecting locally means a saved video
// that has since left the viewer's access simply matches nothing.
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

  if (req.method === 'GET') {
    return res.json({ ids: listIds(await getMyList(email)), max: MAX_ITEMS });
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    // A VIEWER write path — cheap per call, unbounded in aggregate, reachable
    // by anyone approved. The shared limiter is the right instrument here
    // (this costs a Redis write, not money), unlike /api/admin/transcribe.
    if (!(await allow(callerId(req, session, 'mylist')))) {
      return res.status(429).json({ error: 'Too many changes — try again shortly' });
    }

    const raw = req.method === 'POST' ? req.body?.videoId : req.query.videoId;
    // typeof, not coercion: String(['a','b']) would quietly become 'a,b', an
    // id nobody sent.
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ error: 'videoId required' });
    }
    const videoId = raw.trim();

    let video;
    try {
      const videos = await listVideos({ itemsPerPage: 100 });
      video = videos.find((v) => v.guid === videoId);
    } catch (e) {
      console.error('Could not load videos for a saved-list change:', e);
      return res.status(502).json({ error: 'Could not change your list' });
    }
    // 404, not 403, so a restricted viewer cannot probe which ids exist.
    if (!video) return res.status(404).json({ error: 'Not found' });

    const access = await resolveAccess(email, { staff });
    if (!canSeeVideo(access, video)) return res.status(404).json({ error: 'Not found' });

    if (!staff && !isVisibleNow(await getSchedule(video.guid))) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (req.method === 'DELETE') {
      const result = await removeFromMyList(email, videoId);
      if (!result.ok) return res.status(502).json({ error: result.error });
      return res.json({ ok: true, saved: false });
    }

    // Checked before the write so a full list is a clear refusal rather than a
    // silent drop. Re-saving something already present is free.
    if (isFull(await getMyList(email), videoId)) {
      return res
        .status(409)
        .json({ error: `Your list is full (${MAX_ITEMS}). Remove something first.` });
    }
    const result = await saveToMyList(email, videoId);
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ ok: true, saved: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
