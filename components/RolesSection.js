import { useEffect, useState } from 'react';
import { IconPencil, IconTrash } from './icons';

// The Roles section of the admin Access tab: custom roles, and who holds them.
//
// Mounted only for someone holding roles:manage. Everything shown comes from
// GET /api/admin/roles, including the capability catalog — an admin cannot
// invent a capability here, because one that no route enforces would read as
// though it granted something while granting nothing.
//
// Capabilities the viewer does not hold are shown DISABLED, with a reason,
// rather than hidden. The server refuses those edits anyway (no escalation),
// but a greyed box that explains itself beats a 403 after clicking Save — and
// hiding them would make a delegated role manager think the catalog is
// smaller than it is.
export default function RolesSection({ onViewersChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  // { id | null, name, capabilities[] } while a role is being created or edited.
  const [roleDraft, setRoleDraft] = useState(null);
  // { email, roleIds[] } while someone's roles are being chosen.
  const [assignDraft, setAssignDraft] = useState(null);
  const [newEmail, setNewEmail] = useState('');

  async function load() {
    try {
      const r = await fetch('/api/admin/roles');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || 'Could not load roles');
        return;
      }
      setData(d);
      if (d.migrated?.migrated) {
        setNote(
          `Carried ${d.migrated.migrated} ${d.migrated.migrated === 1 ? 'person' : 'people'} over from the ` +
            `old fixed roles into: ${d.migrated.roles.join(', ')}. Those roles can now be edited like any other.`
        );
      }
    } catch {
      setError('Could not load roles — check your connection');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function send(method, body) {
    setBusy(true);
    try {
      const url = method === 'DELETE' ? `/api/admin/roles?id=${encodeURIComponent(body.id)}` : '/api/admin/roles';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        const refused = Array.isArray(d.refused) && d.refused.length ? ` (${d.refused.join(', ')})` : '';
        setError(`${d.error || 'That did not work'}${refused}`);
        return false;
      }
      setError(null);
      await load();
      return true;
    } catch {
      setError('That did not work — check your connection');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveRole() {
    const ok = await send(roleDraft.id ? 'PUT' : 'POST', {
      id: roleDraft.id || undefined,
      name: roleDraft.name,
      capabilities: roleDraft.capabilities,
    });
    if (ok) setRoleDraft(null);
  }

  async function removeRole(role) {
    if (!window.confirm(`Delete the role "${role.name}"? Anyone holding it loses it.`)) return;
    await send('DELETE', { id: role.id });
  }

  async function saveAssignment() {
    const ok = await send('PATCH', { email: assignDraft.email, roleIds: assignDraft.roleIds });
    if (!ok) return;
    setAssignDraft(null);
    setNewEmail('');
    // A role also approves the person as a viewer, so that list may be stale.
    onViewersChanged?.();
  }

  function startAssign() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (data.owners.includes(email)) {
      setError('That address is an owner via ADMIN_EMAILS and already holds every capability.');
      return;
    }
    setError(null);
    setAssignDraft({ email, roleIds: data.assignments[email] || [] });
  }

  if (!data) {
    return (
      <div className="card admin-section">
        <h2 className="admin-section-title">Roles</h2>
        {error ? <p className="form-error">{error}</p> : <p className="text-muted">Loading…</p>}
      </div>
    );
  }

  const held = new Set(data.actor.capabilities);
  const labelOf = Object.fromEntries(data.catalog.map((c) => [c.cap, c.label]));
  const nameOf = Object.fromEntries(data.roles.map((r) => [r.id, r.name]));
  const holders = (roleId) =>
    Object.entries(data.assignments).filter(([, ids]) => ids.includes(roleId)).length;
  const people = Object.keys(data.assignments).sort();

  return (
    <div className="card admin-section">
      <h2 className="admin-section-title">Roles</h2>
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        A role is a set of capabilities you choose. Give people any number of roles and they can do
        everything those roles allow; a role also lets them watch the library.{' '}
        {data.actor.owner ? (
          <>
            You are an <strong>owner</strong> (via <code>ADMIN_EMAILS</code>), so you hold every
            capability and can grant any of them.
          </>
        ) : (
          <>You can only grant capabilities you hold yourself — the rest are greyed out.</>
        )}
      </p>

      {note && <p className="text-muted">{note}</p>}
      {data.legacyRemaining > 0 && (
        <p className="form-error">
          {data.legacyRemaining} grant(s) from the old Admin / Manager roles are still stored. They
          keep working, and reloading this tab converts them.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="admin-row" style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || data.roles.length >= data.maxRoles}
          onClick={() => setRoleDraft({ id: null, name: '', capabilities: [] })}
        >
          New role
        </button>
      </div>

      {roleDraft && (
        <div className="group-card" style={{ marginTop: 14 }}>
          <div className="group-section">
            <label className="group-section-label" htmlFor="role-name">
              {roleDraft.id ? 'Edit role' : 'New role'}
            </label>
            <input
              id="role-name"
              className="input input-sm"
              value={roleDraft.name}
              maxLength={60}
              placeholder="Role name (e.g. Media team)"
              onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })}
            />
          </div>
          {[...new Set(data.catalog.map((c) => c.group))].map((group) => (
            <div key={group} className="group-section">
              <span className="group-section-label">{group}</span>
              <div className="role-cap-grid">
                {data.catalog
                  .filter((c) => c.group === group)
                  .map((c) => {
                    const blocked = !held.has(c.cap);
                    const checked = roleDraft.capabilities.includes(c.cap);
                    return (
                      <label
                        key={c.cap}
                        className="group-grant-item role-cap-item"
                        title={blocked ? "You don't hold this capability, so you can't grant it" : c.cap}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={blocked || busy}
                          onChange={() =>
                            setRoleDraft({
                              ...roleDraft,
                              capabilities: checked
                                ? roleDraft.capabilities.filter((x) => x !== c.cap)
                                : [...roleDraft.capabilities, c.cap],
                            })
                          }
                        />
                        <span className={blocked ? 'text-muted' : undefined}>{c.label}</span>
                      </label>
                    );
                  })}
              </div>
            </div>
          ))}
          <div className="admin-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !roleDraft.name.trim()}
              onClick={saveRole}
            >
              Save role
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRoleDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {data.roles.length > 0 ? (
        <ul className="viewer-list">
          {data.roles.map((role) => {
            const outside = role.capabilities.some((c) => !held.has(c));
            const count = holders(role.id);
            return (
              <li key={role.id} className="viewer-item">
                <div className="viewer-item-main role-row">
                  <span className="viewer-email">{role.name}</span>
                  <span
                    className="text-muted role-locked-note"
                    title={role.capabilities.map((c) => labelOf[c] || c).join('\n')}
                  >
                    {role.capabilities.length} capabilit{role.capabilities.length === 1 ? 'y' : 'ies'} · held by{' '}
                    {count === 0 ? 'nobody' : `${count} ${count === 1 ? 'person' : 'people'}`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-icon"
                    disabled={busy || outside}
                    title={outside ? "This role holds capabilities you don't have, so you can't edit it" : 'Edit role'}
                    aria-label={`Edit ${role.name}`}
                    onClick={() => setRoleDraft({ id: role.id, name: role.name, capabilities: [...role.capabilities] })}
                  >
                    <IconPencil />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    disabled={busy || outside}
                    title={outside ? "This role holds capabilities you don't have, so you can't delete it" : 'Delete role'}
                    aria-label={`Delete ${role.name}`}
                    onClick={() => removeRole(role)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted mt-4">
          No roles yet. Owners still have full access, so nothing is locked — create a role to
          delegate part of it.
        </p>
      )}

      <h3 className="group-section-label" style={{ marginTop: '1.5rem' }}>People</h3>
      <div className="admin-row" style={{ marginTop: 8 }}>
        <input
          type="email"
          placeholder="person@example.com"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startAssign()}
          className="input input-sm"
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || data.roles.length === 0}
          onClick={startAssign}
        >
          Choose roles
        </button>
      </div>

      {assignDraft && (
        <div className="group-card" style={{ marginTop: 14 }}>
          <span className="group-section-label">Roles for {assignDraft.email}</span>
          <div className="role-cap-grid">
            {data.roles.map((role) => {
              const checked = assignDraft.roleIds.includes(role.id);
              const outside = role.capabilities.some((c) => !held.has(c));
              return (
                <label
                  key={role.id}
                  className="group-grant-item role-cap-item"
                  title={outside ? "This role holds capabilities you don't have, so you can't give or take it" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || outside}
                    onChange={() =>
                      setAssignDraft({
                        ...assignDraft,
                        roleIds: checked
                          ? assignDraft.roleIds.filter((x) => x !== role.id)
                          : [...assignDraft.roleIds, role.id],
                      })
                    }
                  />
                  <span className={outside ? 'text-muted' : undefined}>{role.name}</span>
                </label>
              );
            })}
          </div>
          <div className="admin-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveAssignment}>
              Save roles
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAssignDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="viewer-list">
        {data.owners.map((email) => (
          <li key={`owner-${email}`} className="viewer-item">
            <div className="viewer-item-main role-row">
              <span className="viewer-email">{email}</span>
              <span className="role-chip role-chip--admin">owner</span>
              <span className="text-muted role-locked-note">set by ADMIN_EMAILS — change it in Vercel</span>
            </div>
          </li>
        ))}
        {people.map((email) => (
          <li key={email} className="viewer-item">
            <div className="viewer-item-main role-row">
              <span className="viewer-email">{email}</span>
              {data.assignments[email].map((id) => (
                <span key={id} className="role-chip role-chip--custom">{nameOf[id] || id}</span>
              ))}
              <button
                type="button"
                className="btn btn-icon"
                disabled={busy}
                title="Change this person's roles"
                aria-label={`Change roles for ${email}`}
                onClick={() => setAssignDraft({ email, roleIds: [...data.assignments[email]] })}
              >
                <IconPencil />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
