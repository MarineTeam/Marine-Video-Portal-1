import { redis, k } from '../../../lib/redis';
import { listVideos, getVideoFileUrl, podcastMediaFile } from '../../../lib/bunny';
import { getOrder, applyOrder } from '../../../lib/order';
import { isStaffUser } from '../../../lib/roles';
import { resolveAccess, filterVideos } from '../../../lib/groups';
import { listSchedules, filterScheduled } from '../../../lib/schedule';
import { listVideoMeta } from '../../../lib/videoMetaStore';
import { resolveToken } from '../../../lib/feedTokens';
import { getSiteName } from '../../../lib/brandingStore';
import { buildFeedXml, mimeForFile } from '../../../lib/podcastFeed';
import { withMonitorApi } from '../../../lib/monitor';

// Per-subscriber podcast feed. Reachable WITHOUT a session, because podcast
// apps cannot sign in — the long random token in the URL is what identifies
// the viewer (see lib/feedTokens.js).
//
// The token is only an identity claim. Every access rule the logged-in library
// applies is re-applied here on EVERY fetch, against live data:
//   - the viewer must still be an approved viewer (or staff)
//   - their groups still narrow which videos appear
//   - publish/expiry windows still hide out-of-window videos
//
// So removing someone from the approved list kills their feed on the next
// poll, with no separate revocation step. That re-check on every request is
// the reason this route reads Redis rather than trusting anything cached in
// the token.
//
// Deliberately NOT rate-limited the way the video list is: podcast apps poll
// on their own schedule and a 429 would look to the subscriber like the show
// had stopped updating. The token is unguessable and the work per request is
// the same handful of reads the homepage already does.
async function handler(req, res) {
  // A wrong token must look exactly like a nonexistent one.
  const deny = () => res.status(404).json({ error: 'Not found' });

  if (req.method !== 'GET') return deny();

  const email = await resolveToken(req.query.token);
  if (!email) return deny();

  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);
  if (!approved && !staff) return deny();

  const baseUrl = (process.env.AUTH0_BASE_URL || '').replace(/\/+$/, '');

  const [fetched, order, access, schedules, meta, siteName] = await Promise.all([
    listVideos({ itemsPerPage: 100 }),
    getOrder(),
    resolveAccess(email, { staff }),
    listSchedules(),
    listVideoMeta(),
    getSiteName(),
  ]);

  // Same narrowing, same order as the library. Staff and ungrouped viewers
  // resolve to unrestricted, so this is a pass-through for them.
  let videos = filterVideos(access, applyOrder(fetched, order));
  if (!staff) videos = filterScheduled(schedules, videos);

  const mediaType = mimeForFile(podcastMediaFile());
  const items = videos.map((v) => ({
    guid: v.guid,
    title: v.title,
    description: meta[v.guid]?.notes || '',
    url: `${baseUrl}/watch/video/${v.guid}`,
    length: v.length,
    // 7 days, so an app that caches the feed for a few days still has live
    // enclosure URLs when someone finally presses play.
    mediaUrl: getVideoFileUrl(v, 7 * 86400),
    mediaType,
    publishedAt: v.dateUploaded,
  }));

  const xml = buildFeedXml({
    siteName,
    feedUrl: `${baseUrl}/api/feed/${encodeURIComponent(String(req.query.token))}`,
    siteUrl: baseUrl,
    description: `Recordings from ${siteName}.`,
    items,
  });

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  // Private: this feed is specific to one subscriber and must never be held by
  // a shared cache.
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.status(200).send(xml);
}

export default withMonitorApi(handler);
