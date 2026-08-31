import { requireCapability } from '../../../lib/roles';
import { listVideos, deleteVideo, updateVideoTitle, setVideoCollection, getThumbnailUrl } from '../../../lib/bunny';
import { getOrder, setOrder, applyOrder } from '../../../lib/order';
import { logAudit } from '../../../lib/audit';
import { maybeAnnounceReady } from '../../../lib/push';
import { listVideoWatermarkModes, setVideoWatermarkMode } from '../../../lib/watermark';
import { listSchedules, setSchedule, scheduleState } from '../../../lib/schedule';
import { withMonitorApi } from '../../../lib/monitor';

// Bulk video ops (delete, collection assignment) accept either a single `id`
// or an `ids` array, mirroring pages/api/admin/shares.js: every id is
// processed independently and reported back with its own ok/error, and the
// single-id shape keeps its original response for backward compatibility.
function idsFrom(body) {
  return Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
}

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const videos = await listVideos({ itemsPerPage: 100 });
    const order = await getOrder();
    const ordered = applyOrder(videos, order);
    const watermarkModes = await listVideoWatermarkModes();
    const schedules = await listSchedules();

    // Best-effort: notify viewers about any newly-ready video. This admin poll is
    // the natural trigger (admins watch the library refresh while encoding). It
    // must never break the listing, so failures are swallowed.
    try {
      await maybeAnnounceReady(ordered);
    } catch (e) {
      // swallow — announcements are a convenience, the library must still load
    }

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
      }))
    );
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const { title, watermarkMode } = body;
    const ids = idsFrom(body);
    if (ids.length === 0) return res.status(400).json({ error: 'id(s) required' });

    // Per-video publish/expiry window. Always a single id; sending both
    // bounds empty clears the schedule entirely.
    if (Object.prototype.hasOwnProperty.call(body, 'publishAt') ||
        Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
      try {
        const entry = await setSchedule(ids[0], {
          publishAt: body.publishAt,
          expiresAt: body.expiresAt,
        });
        await logAudit(
          actor,
          'video.schedule',
          entry
            ? `${ids[0]} → ${entry.publishAt ? new Date(entry.publishAt).toISOString() : 'now'} … ${entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'forever'}`
            : `${ids[0]} → cleared`
        );
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

    if (title && title.trim()) {
      try {
        await updateVideoTitle(ids[0], title.trim());
        await logAudit(actor, 'video.rename', `${ids[0]} → ${title.trim()}`);
      } catch (e) {
        return res.status(502).json({ error: e.message || 'Update failed' });
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'title, collectionId, watermarkMode, or publishAt/expiresAt required' });
  }

  if (req.method === 'DELETE') {
    const body = req.body || {};
    const ids = idsFrom(body);
    if (ids.length === 0) return res.status(400).json({ error: 'id(s) required' });

    const results = [];
    for (const id of ids) {
      try {
        await deleteVideo(id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message || 'Failed to delete video' });
      }
    }

    // Drop every successfully-deleted id from the saved custom order so it doesn't linger.
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    if (okIds.size > 0) {
      const order = await getOrder();
      const pruned = order.filter((x) => !okIds.has(x));
      if (pruned.length !== order.length) await setOrder(pruned);
    }

    await logAudit(actor, 'video.delete', ids.length === 1 ? ids[0] : `${okIds.size}/${ids.length} video(s)`);

    if (ids.length === 1) {
      const r = results[0];
      return r.ok ? res.json({ ok: true }) : res.status(502).json({ error: r.error });
    }
    return res.json({ results });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
