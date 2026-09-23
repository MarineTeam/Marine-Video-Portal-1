import { requireCapability, roleHasCapability } from '../../../lib/roles';
import { grantVideoToGroups, listGroupIds } from '../../../lib/groups';
import { planUploadGrants } from '../../../lib/uploadGrants';
import { logAudit } from '../../../lib/audit';
import { createVideo, signTusUpload } from '../../../lib/bunny';
import { allow, callerId } from '../../../lib/ratelimit';
import { withMonitorApi } from '../../../lib/monitor';

// Creates the Bunny video record and returns a signed TUS authorization so the
// browser can upload the file bytes directly to Bunny. The API key stays server-side.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;
  const { session } = auth;
  if (req.method !== 'POST') return res.status(405).end();

  if (!(await allow(callerId(req, session, 'upload')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const { title, groupIds: requestedGroups } = req.body || {};
  const cleanTitle = (title || '').trim() || 'Untitled';

  // Groups this upload should be visible to. Everything that can refuse the
  // request is decided HERE, before the bunny.net video exists — a refusal
  // after createVideo would leave an orphan in the library.
  let groupIds = [];
  if (requestedGroups !== undefined && requestedGroups !== null) {
    // Granting a group access is a groups:manage act, whatever form it
    // arrives through. Today every role that can upload also holds it; the
    // check is here so that stops being an accident the day they diverge.
    if (!roleHasCapability(auth.role, 'groups:manage')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    let known;
    try {
      known = await listGroupIds();
    } catch (e) {
      console.error('Could not read groups for an upload:', e);
      return res.status(502).json({ error: 'Could not read groups — try again' });
    }
    const plan = planUploadGrants(requestedGroups, known);
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    groupIds = plan.groupIds;
  }

  let videoId;
  try {
    videoId = await createVideo(cleanTitle);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Failed to create video' });
  }

  // After the video exists, a grant failing must not fail the upload — the
  // browser is about to send the file. It is reported per group instead, so
  // the admin knows exactly which ones still need ticking on the Groups tab.
  const groups = groupIds.length
    ? await grantVideoToGroups(videoId, groupIds)
    : { granted: [], failed: [] };
  if (groups.granted.length) {
    await logAudit(
      auth.email,
      'group.update',
      `upload ${videoId} granted to ${groups.granted.length} group(s): ${groups.granted.join(', ')}`
    );
  }

  const { libraryId, signature, expires } = signTusUpload(videoId);
  res.json({ videoId, libraryId, signature, expires, title: cleanTitle, groups });
}

export default withMonitorApi(handler);
