import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getThumbnailUrl } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { getOrder, applyOrder } from '../../lib/order';
import { isStaffUser } from '../../lib/roles';
import { resolveAccess, filterVideos } from '../../lib/groups';
import { listSchedules, filterScheduled } from '../../lib/schedule';
import { isVerified, recordObservation } from '../../lib/verification';
import { allow, callerId } from '../../lib/ratelimit';
import { isGeoAllowed } from '../../lib/geo';
import { withMonitorApi } from '../../lib/monitor';

async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  if (!(await allow(callerId(req, session, 'videos')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const email = session.user.email.toLowerCase();
  const [approved, staff] = await Promise.all([
    redis.sismember(k('approved_viewers'), email),
    isStaffUser(email),
  ]);

  if (!approved && !staff) {
    return res.status(403).json({ error: 'not_approved' });
  }

  // Admins have their own separate whitelist/toggle (plus a bypass-email
  // safety net) — see lib/geo.js. Both are off by default.
  if (!(await isGeoAllowed(req, email, staff))) {
    return res.status(403).json({ error: 'geo_blocked' });
  }

  // Always observe the email_verified claim; only enforce it when an admin has
  // turned enforcement on (off by default — see lib/verification.js). The
  // observation is what makes the blast radius visible BEFORE the toggle.
  await recordObservation(email, session);
  if (!(await isVerified(session, { staff }))) {
    return res.status(403).json({ error: 'not_verified' });
  }

  // Track viewer activity for the admin "last seen" column.
  if (approved) await redis.hset(k('viewer_last_seen'), { [email]: Date.now() });

  const storedCount = await redis.get(k('homepage_video_count'));
  const totalLimit = storedCount ? Number(storedCount) : 2;

  const q = (req.query.q || '').trim().toLowerCase();
  const collection = (req.query.collection || '').trim();
  const fetched = await listVideos({ itemsPerPage: 100 });
  const order = await getOrder();
  // Group gating happens BEFORE the search/collection/cap logic below, so a
  // restricted viewer's search and pagination totals describe the library
  // they can actually see rather than the whole one. Staff and viewers in no
  // group resolve to UNRESTRICTED and this filter is a pass-through.
  const access = await resolveAccess(email, { staff });
  let ordered = filterVideos(access, applyOrder(fetched, order));
  // Scheduled publish/expiry. Staff keep seeing everything so they can check a
  // video before it goes live; for viewers an out-of-window video is simply
  // absent, exactly as if it hadn't been uploaded yet.
  if (!staff) ordered = filterScheduled(await listSchedules(), ordered);
  // A search or collection filter looks across the whole library; the default
  // (unfiltered) view respects the admin's homepage cap.
  let allVideos;
  if (q) {
    allVideos = ordered.filter((v) => (v.title || '').toLowerCase().includes(q));
  } else if (collection) {
    allVideos = ordered.filter((v) => v.collectionId === collection);
  } else {
    allVideos = ordered.slice(0, totalLimit);
  }

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const start = (page - 1) * perPage;
  const pageVideos = allVideos.slice(start, start + perPage);

  res.json({
    videos: pageVideos.map((v) => ({ id: v.guid, title: v.title, thumbnail: getThumbnailUrl(v) })),
    page,
    totalPages: Math.max(1, Math.ceil(allVideos.length / perPage)),
  });
}

export default withMonitorApi(handler);
