import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getThumbnailUrl } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { getOrder, applyOrder } from '../../lib/order';
import { isStaffUser } from '../../lib/roles';
import { resolveAccess, filterVideos } from '../../lib/groups';
import { listSchedules, filterScheduled } from '../../lib/schedule';
import { listVideoMeta } from '../../lib/videoMetaStore';
import { metaMatches } from '../../lib/videoMeta';
import { bookIndex, parsePassageQuery, parseReferences, videoMatchesPassage } from '../../lib/scripture';
import { queryStems, stemSet, stemsMatch } from '../../lib/stem';
import { matchingTranscriptGuids } from '../../lib/captions';
import { listTranscriptText, matchingTranslatedGuids } from '../../lib/captionsStore';
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

  // typeof, not coercion: a repeated ?q= or ?collection= arrives as an
  // array, and calling .trim() on one threw — a 500 from a malformed URL.
  // Now it is simply no search / no filter.
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const collection = typeof req.query.collection === 'string' ? req.query.collection.trim() : '';
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
  // A group's own window (lib/schedule.js) opens a video early for its
  // members, so the viewer's group ids ride along.
  if (!staff) ordered = filterScheduled(await listSchedules(), ordered, Date.now(), access.groupIds);

  // ?index=books — "Browse by book" on the homepage. A MODE of this route
  // rather than a route of its own, deliberately: every check above (approval,
  // region, verified email, groups, schedule) is the gate the answer needs,
  // and a second route would be a second copy of that gate to keep in step.
  // Counted over `ordered` — already narrowed — because a count is itself
  // information: "Philippians (3)" says three videos exist.
  if (req.query.index === 'books') {
    const meta = await listVideoMeta();
    const books = bookIndex(ordered, (v) =>
      parseReferences(`${v.title || ''}\n${meta[v.guid]?.notes || ''}`)
    );
    return res.json({ books });
  }
  // A search or collection filter looks across the whole library; the default
  // (unfiltered) view respects the admin's homepage cap.
  let allVideos;
  if (q) {
    // Search matches sermon notes as well as titles, so "that talk on
    // Philippians" is findable. Matching runs over `ordered`, which the group
    // and schedule filters above have already narrowed — searching can never
    // surface a video the viewer isn't allowed to see.
    // Titles, notes AND transcripts. The transcript half is the same shape of
    // claim as the notes half - "this video is about that" - so it is a third
    // OR rather than a separate mechanism, and it inherits the guarantee
    // above for free: matching still runs over `ordered`, which the group and
    // schedule filters have already narrowed.
    //
    // Transcripts are read as the TEXT map, not cue arrays: search needs none
    // of the timings, and cue bodies run ~1,500 per 90-minute service. That
    // split is why lib/captionsStore.js keeps two hashes.
    //
    // Every LANGUAGE, too: translations are matched inside Redis and arrive as
    // ids only (lib/captionsStore.js), so they join `spoken` without every
    // search loading every translation — and, like every other match here,
    // they can only mark videos already in `ordered`.
    const [meta, transcriptText, translatedIds] = await Promise.all([
      listVideoMeta(),
      listTranscriptText(),
      matchingTranslatedGuids(q),
    ]);
    const spoken = new Set([...matchingTranscriptGuids(transcriptText, q), ...translatedIds]);
    // A query that IS a scripture reference ('philippians 2') also matches a
    // title or notes citing an OVERLAPPING passage in any spelling ('Phil
    // 1:27-2:11'). A fourth OR over the same already-filtered `ordered`, so
    // it inherits the guarantee above, and it only adds matches.
    const passage = parsePassageQuery(q);
    // And a fifth: the query's WORDS by stem ('baptism' finds 'baptised'),
    // in title or notes, every word somewhere. Not for a passage query —
    // stems would read 'philippians 2' as the word 'philippians' and widen it
    // to the whole book, so a passage is answered by passage overlap alone.
    const stems = passage ? [] : queryStems(q);
    allVideos = ordered.filter(
      (v) =>
        (v.title || '').toLowerCase().includes(q) ||
        metaMatches(meta[v.guid], q) ||
        spoken.has(v.guid) ||
        videoMatchesPassage(v.title, meta[v.guid]?.notes, passage) ||
        stemsMatch(stemSet(`${v.title || ''}\n${meta[v.guid]?.notes || ''}`), stems)
    );
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
