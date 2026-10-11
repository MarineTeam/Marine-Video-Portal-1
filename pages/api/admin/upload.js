import { requireCapability } from '../../../lib/roles';
import { effectiveScopeGroups, isScoped } from '../../../lib/staffScopeRules';
import { grantVideoToGroups, listGroupIds, loadGroupsById } from '../../../lib/groups';
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
  if (isScoped(auth)) {
    // A group-scoped uploader's video goes to their own groups — the ones
    // they chose, or all of them — and never anyone else's. Granting their own
    // groups needs no groups:manage: it is the only way the video lands inside
    // their scope at all.
    let groupsById;
    try {
      groupsById = await loadGroupsById();
    } catch (e) {
      console.error('Could not read groups for an upload:', e);
      return res.status(502).json({ error: 'Could not read groups — try again' });
    }
    const mine = effectiveScopeGroups(auth.staffScope, groupsById);
    const wanted = requestedGroups === undefined || requestedGroups === null ? mine : requestedGroups;
    if (!Array.isArray(wanted) || wanted.some((id) => typeof id !== 'string' || !mine.includes(id))) {
      return res.status(403).json({ error: 'You can only grant an upload to your own groups' });
    }
    const plan = planUploadGrants(wanted, Object.keys(groupsById));
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    if (!plan.groupIds.length) {
      return res.status(400).json({ error: 'Choose at least one of your groups for this video' });
    }
    groupIds = plan.groupIds;
  } else if (requestedGroups !== undefined && requestedGroups !== null) {
    // Granting a group access is a groups:manage act, whatever form it
    // arrives through. With custom roles someone can hold videos:manage
    // without groups:manage: they may upload, but not grant the upload to a
    // group.
    if (!auth.capabilities.includes('groups:manage')) {
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
