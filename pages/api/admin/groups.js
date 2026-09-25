import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/roles';
import { pruneGroupFromSchedules } from '../../../lib/schedule';
import { redis, k } from '../../../lib/redis';
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMember,
} from '../../../lib/groups';

// Viewer groups, gated on 'groups:manage'. Nothing here can change who holds
// a ROLE (that's /api/admin/roles), so nobody widens their own power through
// this route.
//
// Group membership gates what a viewer sees — see lib/groups.js for the
// opt-in rule (no groups = full library, unchanged).
//
// ONLY APPROVED VIEWERS CAN BE PUT IN A GROUP. Membership decides what
// somebody sees, so a membership for an address with no account is a row
// nothing reads and nothing cleans — and one that becomes real the day that
// address is approved. Refusals are REPORTED rather than dropped: an admin
// who pastes twelve addresses and is told "12 added" has no way to discover
// that three were typos until someone says they cannot see anything.
//
// MEMBERSHIP ADDITIONALLY NEEDS 'viewers:manage' — the same split the sibling
// repos make. Roles are custom, so someone can hold groups:manage without
// viewers:manage, and membership is about people: a group's member list hands
// out addresses, and the per-address result of adding members answers "is
// this person an approved viewer?", which is the viewer list by another door.
// Such a caller keeps the group RECORD — name, grants, delete — and sees a
// member COUNT instead of the members.
const PEOPLE = 'viewers:manage';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'groups:manage');
  if (!auth) return;
  const actor = auth.email;
  const maySeePeople = auth.capabilities.includes(PEOPLE);

  if (req.method === 'GET') {
    const groups = await listGroups();
    if (maySeePeople) return res.json(groups);
    return res.json(groups.map(({ members, ...g }) => ({ ...g, memberCount: (members || []).length })));
  }

  const body = req.body || {};
  const touchesMembers =
    (req.method === 'POST' && body.groupId) || (req.method === 'DELETE' && body.email);
  if (touchesMembers && !maySeePeople) {
    return res.status(403).json({ error: 'Changing who is in a group needs viewers:manage too' });
  }

  if (req.method === 'POST') {
    // Create a group, or add members to one, depending on the payload.
    if (body.groupId) {
      const emails = Array.isArray(body.emails)
        ? body.emails
        : String(body.emails || '').split(/[\s,;]+/);
      // A read failure passes null, which means "could not check" — better
      // than refusing everyone because Redis blinked.
      let approved = null;
      try {
        approved = new Set((await redis.smembers(k('approved_viewers'))) || []);
      } catch (e) {
        console.error('Could not read the approved viewers:', e);
        approved = null;
      }
      try {
        const result = await addGroupMembers(body.groupId, emails, { approved });
        const { added, unknown, invalid } = result;
        if (!added.length && !unknown.length && !invalid.length) {
          return res.status(400).json({ error: 'No valid emails provided' });
        }
        if (added.length) {
          await logAudit(
            actor,
            'group.members.add',
            `${added.length} → ${body.groupId}` +
              (unknown.length ? ` (${unknown.length} not approved)` : '')
          );
        }
        return res.json({ ok: true, added, unknown, invalid });
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
      // Its publish windows go with it (lib/schedule.js). Best-effort after the
      // delete itself: a window naming a deleted group matches no viewer.
      await pruneGroupFromSchedules(body.groupId).catch((e) =>
        console.error('Could not clear a deleted group from video schedules:', e)
      );
      await logAudit(actor, 'group.delete', String(body.groupId));
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
