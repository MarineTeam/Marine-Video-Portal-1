import { requireCapability } from '../../../lib/roles';
import { deleteVideo, updateVideoTitle, setVideoCollection, getThumbnailUrl } from '../../../lib/bunny';
import { listAllVideos } from '../../../lib/videoLibrary';
import { getOrder, setOrder, applyOrder } from '../../../lib/order';
import { logAudit } from '../../../lib/audit';
import { maybeAnnounceReady } from '../../../lib/push';
import { listVideoWatermarkModes, setVideoWatermarkMode } from '../../../lib/watermark';
import { clearSchedule, listSchedules, setSchedule, scheduleState, validateGroupWindows, validateRepeat } from '../../../lib/schedule';
import { listVideoMeta, setVideoMeta, clearVideoMeta } from '../../../lib/videoMetaStore';
import { clearVideoRatingCounts, getRatingCounts } from '../../../lib/ratingsStore';
import { listGroupIds, pruneVideosFromGroups } from '../../../lib/groups';
import { countsByVideo, countsFor, summarize } from '../../../lib/ratings';
import { listPublicVideos, clearPublicVideo } from '../../../lib/publicVideos';
import { formatChaptersText } from '../../../lib/videoMeta';
import { collectFinishedTranscripts } from '../../../lib/transcriptCollect';
import { clearTranscript } from '../../../lib/captionsStore';
import { clearComments } from '../../../lib/commentsStore';
import { withMonitorApi } from '../../../lib/monitor';
import { SCOPED_REFUSAL, guidsInScope, scopedDeleteProblem } from '../../../lib/staffScope';
import { isScoped, scheduleGroupsProblem, videoInScope } from '../../../lib/staffScopeRules';
import { loadGroupsById } from '../../../lib/groups';

// Bulk video ops (delete, collection assignment) accept either a single `id`
// or an `ids` array, mirroring pages/api/admin/shares.js: every id is
// processed independently and reported back with its own ok/error, and the
// single-id shape keeps its original response for backward compatibility.
function idsFrom(body) {
  return Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeSchedule(id, entry) {
  if (!entry) return `${id} → cleared`;
  const when = (ts) => (ts ? new Date(ts).toISOString() : null);
  let text = `${id} → ${when(entry.publishAt) || 'now'} … ${when(entry.expiresAt) || 'forever'}`;
  if (entry.repeat) {
    const { days, start, end, timeZone } = entry.repeat;
    text += `, weekly ${days.map((d) => DAY_NAMES[d]).join('/')} ${start}–${end} ${timeZone}`;
  }
  if (entry.groups) text += `, group windows: ${Object.keys(entry.groups).join(', ')}`;
  return text;
}

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;
  const actor = auth.email;
  // Group-scoped staff (lib/staffScopeRules.js) see and change only the
  // videos their groups grant, and none of the library-wide acts.
  const scoped = isScoped(auth);

  if (req.method === 'GET') {
    // The whole library, not bunny's newest 100 — a video past the first
    // page used to have no row here. See lib/videoLibrary.js.
    const { videos: library, truncated } = await listAllVideos();
    const videos = scoped ? library.filter((v) => videoInScope(auth, v)) : library;
    const order = await getOrder();
    const ordered = applyOrder(videos, order);
    const watermarkModes = await listVideoWatermarkModes();
    const schedules = await listSchedules();
    const meta = await listVideoMeta();
    const publicIds = new Set(await listPublicVideos());

    // Best-effort: notify viewers about any newly-ready video. This admin poll is
    // the natural trigger (admins watch the library refresh while encoding). It
    // must never break the listing, so failures are swallowed.
    try {
      await maybeAnnounceReady(ordered);
    } catch (e) {
      // swallow — announcements are a convenience, the library must still load
    }

    // Best-effort, same contract: collect any transcription bunny has finished
    // since it was queued, so the admin does not have to remember a second
    // click minutes later. Bounded per request by lib/transcribeQueue.js;
    // failures are retried on the next load (and by the scheduled job,
    // pages/api/cron/transcripts.js) and age out after three days.
    try {
      const { collected } = await collectFinishedTranscripts();
      for (const item of collected) {
        await logAudit(
          actor,
          'video.transcript_ingest',
          `${item.videoId} (${item.language}, ${item.cues}, collected automatically)`
        );
      }
    } catch (e) {
      // swallow — the library must still load
    }

    // Totals only — the counters hold no identity, so this cannot tell an
    // admin WHO rated anything. See lib/ratings.js.
    const ratings = countsByVideo(await getRatingCounts());

    // A header rather than a field, so the list keeps its shape: set only when
    // the library is larger than one read, and the tab says so.
    if (truncated) res.setHeader('X-Library-Truncated', '1');
    return res.json(
      ordered.map((v) => ({
        id: v.guid,
        title: v.title,
        dateUploaded: v.dateUploaded,
        status: v.status,
        encodeProgress: v.encodeProgress,
        collectionId: v.collectionId || '',
        thumbnail: getThumbnailUrl(v),
        views: v.views || 0,
        watermarkMode: watermarkModes[v.guid] || 'default',
        schedule: schedules[v.guid] || null,
        scheduleState: scheduleState(schedules[v.guid]),
        notes: meta[v.guid]?.notes || '',
        chapters: meta[v.guid]?.chapters || [],
        chaptersText: formatChaptersText(meta[v.guid]?.chapters),
        isPublic: publicIds.has(v.guid),
        // null when nobody has voted, so the UI shows nothing rather than a
        // row of zeroes that reads like a bad score.
        rating: summarize(countsFor(ratings, v.guid)),
      }))
    );
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const { title, watermarkMode } = body;
    const ids = idsFrom(body);
    if (ids.length === 0) return res.status(400).json({ error: 'id(s) required' });
    if (scoped) {
      // Collections are shared across groups: moving a video between them
      // changes who else can see it.
      if (typeof body.collectionId === 'string') return res.status(403).json({ error: SCOPED_REFUSAL });
      const allowed = await guidsInScope(auth, ids);
      if (ids.some((id) => !allowed.has(id))) return res.status(404).json({ error: 'Video not found' });
    }

    // Per-video chapters and notes. Always a single id. Sending both fields
    // empty clears the entry entirely.
    if (Object.prototype.hasOwnProperty.call(body, 'notes') ||
        Object.prototype.hasOwnProperty.call(body, 'chaptersText')) {
      try {
        const { meta, ignored } = await setVideoMeta(ids[0], {
          notes: body.notes,
          chaptersText: body.chaptersText,
        });
        await logAudit(
          actor,
          'video.meta',
          `${ids[0]} → ${meta ? `${meta.chapters.length} chapter(s), ${meta.notes.length} note chars` : 'cleared'}`
        );
        // `ignored` is how the admin finds out which chapter lines didn't parse.
        return res.json({
          ok: true,
          notes: meta?.notes || '',
          chapters: meta?.chapters || [],
          chaptersText: formatChaptersText(meta?.chapters),
          ignored,
        });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Per-video publish/expiry window. Always a single id; sending both
    // bounds empty clears the schedule entirely.
    if (Object.prototype.hasOwnProperty.call(body, 'publishAt') ||
        Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
      // The weekly repeat and group windows travel with the dates: the whole
      // entry is replaced on every save (lib/schedule.js).
      const repeat = body.repeat ?? null;
      const repeatError = validateRepeat(repeat);
      if (repeatError) return res.status(400).json({ error: repeatError });
      let groups = null;
      if (body.groups != null) {
        let known;
        try {
          known = await listGroupIds();
        } catch {
          return res.status(500).json({ error: 'Could not read the groups.' });
        }
        const checked = validateGroupWindows(body.groups, known);
        if (checked.error) return res.status(400).json({ error: checked.error });
        groups = checked.groups;
      }
      // A scoped caller sets per-group windows for their own groups only;
      // every other group's window must come back exactly as stored.
      if (scoped) {
        let stored;
        let groupsById;
        try {
          [stored, groupsById] = await Promise.all([listSchedules(), loadGroupsById()]);
        } catch {
          return res.status(500).json({ error: 'Could not read the schedule.' });
        }
        const problem = scheduleGroupsProblem(auth, stored[ids[0]]?.groups, groups, groupsById);
        if (problem) return res.status(403).json({ error: problem });
      }
      try {
        const entry = await setSchedule(ids[0], {
          publishAt: body.publishAt,
          expiresAt: body.expiresAt,
          repeat,
          groups,
        });
        await logAudit(actor, 'video.schedule', describeSchedule(ids[0], entry));
        return res.json({ ok: true, schedule: entry, scheduleState: scheduleState(entry) });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Per-video watermark override — always a single id (there's no bulk
    // watermark control), 'default' clears back to inheriting the global setting.
    if (typeof watermarkMode === 'string') {
      try {
        await setVideoWatermarkMode(ids[0], watermarkMode);
        await logAudit(actor, 'video.watermark', `${ids[0]} → ${watermarkMode}`);
        return res.json({ ok: true });
      } catch (e) {
        return res.status(502).json({ error: e.message || 'Update failed' });
      }
    }

    if (typeof body.collectionId === 'string') {
      const results = [];
      for (const id of ids) {
        try {
          await setVideoCollection(id, body.collectionId);
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e.message || 'Update failed' });
        }
      }
      await logAudit(actor, 'video.collection', `${ids.length} video(s) → ${body.collectionId || 'none'}`);
      if (ids.length === 1) {
        const r = results[0];
        return r.ok ? res.json({ ok: true }) : res.status(502).json({ error: r.error });
      }
      return res.json({ results });
    }

    // typeof, not truthiness — see pages/api/admin/collections.js. A
    // wrong-typed title threw on .trim() and became a 500; it now falls
    // through to the 400 below, which is what "no valid action" means.
    if (typeof title === 'string' && title.trim()) {
      try {
        await updateVideoTitle(ids[0], title.trim());
        await logAudit(actor, 'video.rename', `${ids[0]} → ${title.trim()}`);
      } catch (e) {
        return res.status(502).json({ error: e.message || 'Update failed' });
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'title, collectionId, watermarkMode, publishAt/expiresAt, notes, or chaptersText required' });
  }

  if (req.method === 'DELETE') {
    const body = req.body || {};
    const ids = idsFrom(body);
    if (ids.length === 0) return res.status(400).json({ error: 'id(s) required' });

    const results = [];
    for (const id of ids) {
      const refused = await scopedDeleteProblem(auth, id);
      if (refused) {
        results.push({ id, ok: false, error: refused.error, status: refused.status });
        continue;
      }
      try {
        await deleteVideo(id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message || 'Failed to delete video' });
      }
    }

    // Drop every successfully-deleted id from the saved custom order so it doesn't linger.
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    // Don't leave chapters/notes behind for a video that no longer exists.
    for (const id of okIds) {
      await clearVideoMeta(id);
      // A deleted guid must not linger in the public set.
      await clearPublicVideo(id);
      // ...nor carry its score over to a recycled bunny.net id.
      await clearVideoRatingCounts(id);
      // ...nor leave its transcript behind, in any language — cues, search
      // text and the language index. Best-effort: it reports, never throws.
      await clearTranscript(id);
      // ...nor open a recycled id with the previous video's conversation.
      await clearComments(id).catch((e) => console.error('Could not clear comments:', e));
      // ...nor keep its publish window — clearSchedule existed and nothing
      // called it, so every deleted video's schedule stayed in
      // pvp:video_schedule for good...
      await clearSchedule(id).catch((e) => console.error('Could not clear schedule:', e));
      // ...nor its watermark override ('default' is how one is removed).
      await setVideoWatermarkMode(id, 'default').catch((e) =>
        console.error('Could not clear watermark mode:', e)
      );
    }
    // ...nor stay granted to a group — a cancelled upload deletes its video,
    // and the upload may already have ticked it into groups.
    if (okIds.size > 0) await pruneVideosFromGroups([...okIds]);
    if (okIds.size > 0) {
      const order = await getOrder();
      const pruned = order.filter((x) => !okIds.has(x));
      if (pruned.length !== order.length) await setOrder(pruned);
    }

    await logAudit(actor, 'video.delete', ids.length === 1 ? ids[0] : `${okIds.size}/${ids.length} video(s)`);

    if (ids.length === 1) {
      const r = results[0];
      return r.ok ? res.json({ ok: true }) : res.status(r.status || 502).json({ error: r.error });
    }
    return res.json({
      results: results.map((r) => ({ id: r.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) })),
    });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
