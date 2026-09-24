import { redis, k } from '../../../../lib/redis';
import { getThumbnailUrl, getVideoById } from '../../../../lib/bunny';
import { isStaffUser } from '../../../../lib/roles';
import { resolveAccess, canSeeVideo } from '../../../../lib/groups';
import { getSchedule, isVisibleFor } from '../../../../lib/schedule';
import { resolveToken } from '../../../../lib/feedTokens';
import { podcastFeedEnabled } from '../../../../lib/podcastConfig';
import { allow } from '../../../../lib/ratelimit';
import { withMonitorApi } from '../../../../lib/monitor';

// One podcast episode's ARTWORK: GET /api/feed/<token>/<videoId>.jpg.
//
// Why a route and not a signed URL in the feed, like the enclosures: podcast
// apps cache episode art for a long time, KEYED ON THE URL. A signed CDN URL
// in the feed changes on every refresh (its expiry moves), so an app would
// re-download every episode's art on every poll, and what it had cached would
// point at a signature that has since expired. The feed gives this stable
// address instead; each fetch is re-checked here and answered with a
// short-lived signed redirect that nothing needs to cache.
//
// Reachable WITHOUT a session, like the feed. The checks are the feed's, per
// request, and every refusal is the same bare 404:
//   - the token names someone, who is still an approved viewer or staff;
//   - the video exists, is inside their groups, and — unless they are staff —
//     inside its publish window. The window is read FAILING CLOSED here: this
//     URL has no session behind it, so an unreadable schedule must not be
//     read as "no constraint".
const ART_TTL_SECONDS = 15 * 60;

// A thumbnail file name as bunny reports it ('thumbnail.jpg', or
// 'thumbnail_1a2b3c.jpg' after a custom upload). It becomes a signed CDN path,
// so anything that is not a plain file name is refused.
const THUMBNAIL_FILE = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$/;
const VIDEO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req, res) {
  const deny = () => res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny();
  if (!podcastFeedEnabled()) return deny();

  // '<videoId>.jpg' only. typeof first: a repeated key arrives as an array.
  const file = typeof req.query.file === 'string' ? req.query.file : '';
  if (!file.endsWith('.jpg')) return deny();
  const videoId = file.slice(0, -4);
  if (!VIDEO_ID.test(videoId)) return deny();

  // The shared limiter (60 per 10 seconds), keyed per token: enough for an
  // app fetching a feed's worth of art at once, and it still bounds what a
  // leaked URL can cost at bunny. Unlike the feed document itself, which is
  // deliberately unlimited — a 429 here costs an image, not the whole show.
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!(await allow(`feed-art:${token.slice(0, 16) || 'anon'}`))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const email = await resolveToken(token);
  if (!email) return deny();
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return deny();

  let video;
  try {
    video = await getVideoById(videoId);
  } catch {
    return deny();
  }
  if (!video?.guid) return deny();

  const access = await resolveAccess(email, { staff });
  if (!canSeeVideo(access, video)) return deny();

  if (!staff) {
    let schedule;
    try {
      schedule = await getSchedule(video.guid);
    } catch {
      return deny();
    }
    if (!isVisibleFor(schedule, access.groupIds)) return deny();
  }

  const name = String(video.thumbnailFileName || 'thumbnail.jpg');
  if (!THUMBNAIL_FILE.test(name)) return deny();
  const url = getThumbnailUrl({ guid: video.guid, thumbnailFileName: name }, ART_TTL_SECONDS);
  if (!url) return deny();

  // private + short: the Location carries a signed URL.
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Location', url);
  res.statusCode = 302;
  return res.end();
}

export default withMonitorApi(handler);
