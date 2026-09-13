import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/roles';
import { listPublicVideos, setPublicVideo } from '../../../lib/publicVideos';

// Marking a video public is the only action in this portal that makes content
// readable without a login, so it lives on its own route behind
// 'settings:manage' — admin-only — rather than riding along with
// 'videos:manage' in pages/api/admin/videos.js.
//
// That is a deliberate narrowing: a manager can already curate the library and
// share links to named people, but publishing to the open internet is a
// different kind of decision and belongs with the admins who own the portal's
// posture. If that proves too strict in practice it is a one-line change here,
// and the capability map in lib/roles.js is the place to reason about it.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'settings:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    return res.json({ videoIds: await listPublicVideos() });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const videoId = String(body.videoId || '').trim();
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    // Explicit boolean only — a missing field must not be read as "make it
    // public". Widening access should never happen by omission.
    if (typeof body.isPublic !== 'boolean') {
      return res.status(400).json({ error: 'isPublic must be true or false' });
    }

    try {
      const result = await setPublicVideo(videoId, body.isPublic);
      await logAudit(actor, 'video.public', `${videoId} → ${body.isPublic ? 'public' : 'private'}`);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
