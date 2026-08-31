import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/roles';
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
} from '../../../lib/groups';

// Viewer groups. Admins and managers both curate the library, so both hold
// 'groups:manage'; nothing here can change who holds a ROLE (that's
// /api/admin/roles, admin-only), so a manager can never widen their own
// power through this route.
//
// Group membership gates what a viewer sees — see lib/groups.js for the
// opt-in rule (no groups = full library, unchanged).
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'groups:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    return res.json(await listGroups());
  }

  const body = req.body || {};

  if (req.method === 'POST') {
    // Create a group, or add members to one, depending on the payload.
    if (body.groupId) {
      const emails = Array.isArray(body.emails)
        ? body.emails
        : String(body.emails || '').split(/[\s,;]+/);
      try {
        const { added } = await addGroupMembers(body.groupId, emails);
        if (!added.length) return res.status(400).json({ error: 'No valid emails provided' });
        await logAudit(actor, 'group.members.add', `${added.length} → ${body.groupId}`);
        return res.json({ ok: true, added });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    try {
      const group = await createGroup(body.name, actor);
      await logAudit(actor, 'group.create', group.name);
      return res.json(group);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'PATCH') {
    if (!body.groupId) return res.status(400).json({ error: 'groupId required' });
    try {
      const group = await updateGroup(body.groupId, {
        name: body.name,
        collectionIds: body.collectionIds,
        videoIds: body.videoIds,
      });
      const grantCount = group.collectionIds.length + group.videoIds.length;
      await logAudit(actor, 'group.update', `${group.name} — ${grantCount} grant(s)`);
      return res.json(group);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!body.groupId) return res.status(400).json({ error: 'groupId required' });
    try {
      if (body.email) {
        await removeGroupMember(body.groupId, body.email);
        await logAudit(actor, 'group.members.remove', `${body.email} ← ${body.groupId}`);
        return res.json({ ok: true });
      }
      const result = await deleteGroup(body.groupId);
      await logAudit(actor, 'group.delete', String(body.groupId));
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
