import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { isLikelyEmail } from '../../../lib/auth';
import {
  requireCapability,
  CAP,
  CAPABILITY_INFO,
  MAX_ROLES,
  cleanRoleIds,
  deleteRole,
  holdersOf,
  isEnvAdmin,
  isValidRoleId,
  loadRoleAssignments,
  loadRoles,
  normalizeCapabilities,
  normalizeRoleName,
  ownerEmails,
  resolveCapabilities,
  roleIdFromName,
  saveRole,
  setRolesForEmail,
  sortedRoles,
  undelegatableCapabilities,
  assignmentNeedsViewerManage,
} from '../../../lib/roles';
import { findLegacyAssignments, migrateLegacyRoles } from '../../../lib/roleMigration';
import { loadStaffScopes, setScopeForEmail } from '../../../lib/staffScopeStore';
import { MAX_SCOPE_GROUPS, normalizeScope } from '../../../lib/staffScopeRules';
import { loadGroupsById } from '../../../lib/groups';

// Custom roles: create, edit and delete them, and decide who holds them.
//
//   GET     roles, assignments, the capability catalog, and the caller's own
//           capabilities (the ceiling the UI greys out against)
//   POST    { name, capabilities }        create a role
//   PUT     { id, name, capabilities }    edit a role
//   PATCH   { email, roleIds }            replace one person's roles
//   DELETE  ?id=                          delete a role
//
// Three guards are the whole point of this route rather than the UI writing
// the hashes directly:
//
//   1. No escalation. The actor may only create, edit, delete or assign a
//      role whose capabilities they hold themselves — on BOTH sides of an
//      edit, so they cannot tamper with a role above them either. Owners
//      (ADMIN_EMAILS) hold everything, so this is invisible to them.
//   2. Someone always holds roles:manage. No change may leave the portal with
//      nobody able to manage roles — the successor to "never leave zero
//      admins". Owners count, so with ADMIN_EMAILS set this never bites.
//   3. Owners are not assignable. They already hold every capability; storing
//      roles for them would read as though it limited them, and it cannot.
//
// Giving someone a role also adds them to approved_viewers, as granting
// Manager always did: staff who could not watch the library they curate reads
// as a bug every time. Removing their roles leaves them a viewer.
//
// GET also converts the old Admin / Manager grants, best-effort and
// idempotent (lib/roleMigration.js). Until it runs, the read-time fallback
// keeps everyone's old permissions working, so nothing depends on it.
const NO_ROLE_MANAGER =
  'That would leave nobody able to manage roles. Give roles:manage to someone else first.';

async function stillManaged(state) {
  return (await holdersOf(CAP.ROLES_MANAGE, state)).length > 0;
}

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'roles:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    let migrated = null;
    try {
      const result = await migrateLegacyRoles();
      if (result.migrated) {
        migrated = result;
        await logAudit(actor, 'role.migrate', `${result.migrated} → ${result.roles.join(', ')}`);
      }
    } catch (e) {
      console.error('Could not migrate legacy roles:', e);
    }
    try {
      const [rolesById, assignments, legacy, scopes, groupsById] = await Promise.all([
        loadRoles(),
        loadRoleAssignments(),
        findLegacyAssignments().catch(() => ({})),
        loadStaffScopes(),
        loadGroupsById(),
      ]);
      return res.json({
        roles: sortedRoles(rolesById),
        assignments,
        owners: ownerEmails(),
        catalog: CAPABILITY_INFO,
        maxRoles: MAX_ROLES,
        actor: { email: actor, owner: auth.owner, capabilities: auth.capabilities },
        migrated,
        legacyRemaining: Object.keys(legacy).length,
        // Group scopes (lib/staffScopeRules.js): who is limited to which
        // groups, and the groups there are to choose from.
        scopes,
        scopeGroups: Object.values(groupsById)
          .map((g) => ({ id: g.id, name: g.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (e) {
      console.error('Could not load roles:', e);
      return res.status(502).json({ error: 'Could not load roles' });
    }
  }

  const body = req.body || {};

  if (req.method === 'POST') {
    const name = normalizeRoleName(typeof body.name === 'string' ? body.name : '');
    if (!name) return res.status(400).json({ error: 'Give the role a name' });
    const capabilities = normalizeCapabilities(body.capabilities);
    const refused = undelegatableCapabilities(auth.capabilities, capabilities);
    if (refused.length) {
      return res.status(403).json({ error: "You can't grant capabilities you don't hold", refused });
    }
    try {
      if (Object.keys(await loadRoles()).length >= MAX_ROLES) {
        return res.status(400).json({ error: `At most ${MAX_ROLES} roles` });
      }
      const result = await saveRole({ id: roleIdFromName(name), name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAudit(actor, 'role.create', `${name} [${capabilities.join(', ')}]`);
      return res.json({ role: result.role });
    } catch (e) {
      console.error('Could not create the role:', e);
      return res.status(502).json({ error: 'Could not create the role' });
    }
  }

  if (req.method === 'PUT') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!isValidRoleId(id)) return res.status(400).json({ error: 'Bad role id' });
    const name = normalizeRoleName(typeof body.name === 'string' ? body.name : '');
    if (!name) return res.status(400).json({ error: 'Give the role a name' });
    const capabilities = normalizeCapabilities(body.capabilities);
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.status(404).json({ error: 'No such role' });
      const refused = [
        ...new Set([
          ...undelegatableCapabilities(auth.capabilities, current.capabilities),
          ...undelegatableCapabilities(auth.capabilities, capabilities),
        ]),
      ].sort();
      if (refused.length) {
        return res.status(403).json({ error: 'That role is outside your own capabilities', refused });
      }
      const next = { ...rolesById, [id]: { ...current, capabilities } };
      if (!(await stillManaged({ rolesById: next }))) {
        return res.status(400).json({ error: NO_ROLE_MANAGER });
      }
      const result = await saveRole({ ...current, name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAudit(actor, 'role.update', `${name} [${capabilities.join(', ')}]`);
      return res.json({ role: result.role });
    } catch (e) {
      console.error('Could not update the role:', e);
      return res.status(502).json({ error: 'Could not update the role' });
    }
  }

  if (req.method === 'PATCH') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isLikelyEmail(email)) {
      return res.status(400).json({ error: "That doesn't look like an email address" });
    }
    if (isEnvAdmin(email)) {
      return res.status(400).json({
        error: 'That address is an owner via ADMIN_EMAILS and already holds every capability.',
      });
    }
    const requested = Array.isArray(body.roleIds) ? body.roleIds.filter((id) => typeof id === 'string') : [];
    // The group limit: undefined leaves it as it is, null lifts it (the whole
    // portal), an array of group ids sets it.
    const scopeChange = body.scope === undefined ? undefined : normalizeScope(body.scope);
    if (Array.isArray(body.scope) && body.scope.length > MAX_SCOPE_GROUPS) {
      return res.status(400).json({ error: `At most ${MAX_SCOPE_GROUPS} groups in a limit` });
    }
    try {
      const [rolesById, assignments, scopes] = await Promise.all([
        loadRoles(),
        loadRoleAssignments(),
        loadStaffScopes(),
      ]);
      const capsOf = (ids) => normalizeCapabilities((ids || []).flatMap((rid) => rolesById[rid]?.capabilities || []));
      // What is taken away counts as much as what is given: an actor may not
      // strip a role they could not have granted, or "demote whoever is above
      // me" becomes the escalation path.
      const refused = undelegatableCapabilities(
        auth.capabilities,
        [...capsOf(assignments[email]), ...capsOf(requested)]
      );
      if (refused.length) {
        return res.status(403).json({ error: 'That assignment is outside your own capabilities', refused });
      }

      const roleIds = cleanRoleIds(requested, rolesById);
      const granted = capsOf(roleIds);
      if (granted.length && !auth.owner) {
        // Access decision — fail closed: an unreadable approval is "not approved".
        let targetApproved = false;
        try {
          const [approved, caps] = await Promise.all([
            redis.sismember(k('approved_viewers'), email),
            resolveCapabilities(email),
          ]);
          targetApproved = Boolean(approved) || caps.length > 0;
        } catch (e) {
          console.error("Could not read the target's access:", e);
        }
        if (assignmentNeedsViewerManage({ owner: auth.owner, actorCaps: auth.capabilities, grantedCaps: granted, targetApproved })) {
          return res.status(403).json({
            error: "Giving a role to someone who isn't an approved viewer also approves them, which needs viewers:manage",
            refused: [CAP.VIEWERS_MANAGE],
          });
        }
      }

      if (Array.isArray(scopeChange)) {
        const groupsById = await loadGroupsById();
        const bad = scopeChange.filter((id) => !groupsById[id]);
        if (bad.length) return res.status(400).json({ error: `No such group: ${bad.join(', ')}` });
      }

      const nextAssignments = { ...assignments };
      if (roleIds.length) nextAssignments[email] = roleIds;
      else delete nextAssignments[email];
      const nextScopes = { ...scopes };
      if (Array.isArray(scopeChange) && roleIds.length) nextScopes[email] = scopeChange;
      else if (scopeChange === null || !roleIds.length) delete nextScopes[email];
      if (!(await stillManaged({ rolesById, assignments: nextAssignments, scopes: nextScopes }))) {
        return res.status(400).json({ error: NO_ROLE_MANAGER });
      }

      // Write order is the fail-safe one: a limit being SET is saved before
      // the roles, a limit being LIFTED after them, so a failure between the
      // two writes leaves the person with less than was asked for, never more.
      if (Array.isArray(scopeChange)) await setScopeForEmail(email, scopeChange);
      const result = await setRolesForEmail(email, roleIds, rolesById);
      if (!result.ok) return res.status(400).json({ error: result.error });
      // A limit with no roles limits nothing and would silently re-apply to
      // roles given later, so it goes with the last role.
      if (scopeChange === null || !result.roleIds.length) await setScopeForEmail(email, null);
      if (granted.length) await redis.sadd(k('approved_viewers'), email);
      const names = result.roleIds.map((rid) => rolesById[rid].name);
      await logAudit(
        actor,
        'role.assign',
        `${email} → ${names.length ? names.join(', ') : '(none)'}` +
          (Array.isArray(scopeChange) && result.roleIds.length
            ? ` (limited to ${scopeChange.length} group(s))`
            : scopeChange === null && Array.isArray(scopes[email])
              ? ' (limit lifted)'
              : '')
      );
      const scope = !result.roleIds.length ? null : scopeChange !== undefined ? scopeChange : (scopes[email] ?? null);
      return res.json({ email, roleIds: result.roleIds, scope });
    } catch (e) {
      console.error('Could not update the assignment:', e);
      return res.status(502).json({ error: 'Could not update the assignment' });
    }
  }

  if (req.method === 'DELETE') {
    const raw = req.query?.id ?? body.id;
    const id = typeof raw === 'string' ? raw : '';
    if (!isValidRoleId(id)) return res.status(400).json({ error: 'Bad role id' });
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.json({ ok: true });
      const refused = undelegatableCapabilities(auth.capabilities, current.capabilities);
      if (refused.length) {
        return res.status(403).json({ error: 'That role is outside your own capabilities', refused });
      }
      const next = { ...rolesById };
      delete next[id];
      if (!(await stillManaged({ rolesById: next }))) {
        return res.status(400).json({ error: NO_ROLE_MANAGER });
      }
      await deleteRole(id);
      await logAudit(actor, 'role.delete', current.name);
      return res.json({ ok: true });
    } catch (e) {
      console.error('Could not delete the role:', e);
      return res.status(502).json({ error: 'Could not delete the role' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
