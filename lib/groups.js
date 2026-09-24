import crypto from 'crypto';
import { redis, k } from './redis';
import { isLikelyEmail } from './auth';

// Viewer groups: named sets of viewers, each granting access to some
// collections and/or individual videos.
//
// THE OPT-IN RULE, which everything else here exists to protect:
//
//   A viewer who belongs to NO group is unrestricted and sees the whole
//   library, exactly as they did before groups existed.
//
// So deploying this feature changes nothing for anyone until an admin
// actually puts someone in a group, and emptying a viewer out of every
// group restores their full access. Access only ever narrows for people an
// admin has deliberately placed in a group. Do not "simplify" this into a
// default-deny model without a migration that grants every existing viewer
// a group first — default-deny on deploy blanks the library for every
// viewer at once, and it looks exactly like an outage.
//
// A viewer who IS in a group sees the union of that group's grants (and of
// every other group they are in). A member of a group with no grants
// therefore sees nothing — that is a real state an admin can create, and
// the admin UI warns about it rather than the code silently ignoring it.
//
// Share links are a SEPARATE grant path and are deliberately untouched:
// /watch/[shareId] carries its own per-recipient token, so an admin can
// still share one video with someone whose group would not otherwise show
// it to them. Groups gate the library; shares gate one video each.
//
// Admins and managers bypass groups entirely — they are curating the
// library, so they must be able to see all of it.

const GROUPS_KEY = 'groups'; // HASH groupId -> group record JSON
const MAX_NAME_LENGTH = 60;
const MAX_GROUPS = 200;

function membersKey(groupId) {
  return k(`group_members:${groupId}`);
}

// Reverse index, maintained alongside membersKey. Every viewer-facing
// request resolves access, so "which groups is this email in" has to be one
// read rather than a scan of every group's member set.
function userGroupsKey(email) {
  return k(`user_groups:${email}`);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}


// Upstash auto-deserializes JSON-looking strings on read, so a stored record
// may come back already parsed. Same defensive shape as viewers.js's tags.
function parseRecord(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    return {
      id: String(obj.id || ''),
      name: String(obj.name || ''),
      collectionIds: Array.isArray(obj.collectionIds) ? obj.collectionIds.map(String) : [],
      videoIds: Array.isArray(obj.videoIds) ? obj.videoIds.map(String) : [],
      createdAt: Number(obj.createdAt) || null,
      createdBy: obj.createdBy ? String(obj.createdBy) : null,
    };
  } catch {
    return null;
  }
}

export function cleanGroupName(name) {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ');
  return s.slice(0, MAX_NAME_LENGTH);
}

export async function listGroups() {
  const all = (await redis.hgetall(k(GROUPS_KEY))) || {};
  const groups = Object.values(all).map(parseRecord).filter(Boolean);
  const withMembers = await Promise.all(
    groups.map(async (g) => ({
      ...g,
      members: ((await redis.smembers(membersKey(g.id))) || []).sort(),
    }))
  );
  return withMembers.sort((a, b) => a.name.localeCompare(b.name));
}

// Just the ids — for checking that a requested group exists, without reading
// every group's member set the way listGroups does.
export async function listGroupIds() {
  const all = (await redis.hgetall(k(GROUPS_KEY))) || {};
  return Object.values(all).map(parseRecord).filter(Boolean).map((g) => g.id);
}

export async function getGroup(groupId) {
  return parseRecord(await redis.hget(k(GROUPS_KEY), String(groupId)));
}

export async function createGroup(name, actor) {
  const clean = cleanGroupName(name);
  if (!clean) throw new Error('Group name is required');

  const existing = (await redis.hgetall(k(GROUPS_KEY))) || {};
  const records = Object.values(existing).map(parseRecord).filter(Boolean);
  if (records.length >= MAX_GROUPS) throw new Error(`At most ${MAX_GROUPS} groups`);
  if (records.some((g) => g.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error('A group with that name already exists');
  }

  const group = {
    id: crypto.randomUUID(),
    name: clean,
    collectionIds: [],
    videoIds: [],
    createdAt: Date.now(),
    createdBy: normalizeEmail(actor) || null,
  };
  await redis.hset(k(GROUPS_KEY), { [group.id]: JSON.stringify(group) });
  return { ...group, members: [] };
}

export async function updateGroup(groupId, { name, collectionIds, videoIds }) {
  const group = await getGroup(groupId);
  if (!group) throw new Error('Unknown group');

  const next = { ...group };
  if (name !== undefined) {
    const clean = cleanGroupName(name);
    if (!clean) throw new Error('Group name is required');
    next.name = clean;
  }
  if (collectionIds !== undefined) {
    next.collectionIds = [...new Set((collectionIds || []).map(String).filter(Boolean))];
  }
  if (videoIds !== undefined) {
    next.videoIds = [...new Set((videoIds || []).map(String).filter(Boolean))];
  }

  await redis.hset(k(GROUPS_KEY), { [next.id]: JSON.stringify(next) });
  return next;
}

// Called when a collection is deleted. A group scoped to it would otherwise
// keep granting a collection that no longer exists: clutter an admin has to
// reason around when deciding who sees what, and — if an id is ever reused —
// a grant transferring to a collection nobody granted. Same no-orphans rule
// the viewer-side keys follow (weak point #3), applied to a scope.
//
// Best-effort: failing to tidy a scope must not turn a successful delete into
// an error, so the caller does not have to care whether this worked.
export async function pruneCollectionFromGroups(collectionId) {
  const id = String(collectionId || '').trim();
  if (!id) return 0;
  try {
    const groups = await listGroups();
    const touched = groups.filter((g) => (g.collectionIds || []).includes(id));
    for (const group of touched) {
      await updateGroup(group.id, {
        collectionIds: group.collectionIds.filter((c) => c !== id),
      });
    }
    return touched.length;
  } catch (e) {
    console.error('Could not clear a deleted collection from group scopes:', e);
    return 0;
  }
}

// Adds one video to several groups' grants — the upload form's "visible to"
// choice. Each group is its own read-modify-write, so one failing costs only
// that group, and the caller is told exactly which ones did not take: the
// video already exists by the time this runs, and the admin must be able to
// see which groups still need it ticked by hand.
export async function grantVideoToGroups(videoId, groupIds) {
  const id = String(videoId || '').trim();
  const granted = [];
  const failed = [];
  if (!id) return { granted, failed: [...(groupIds || [])] };
  for (const groupId of groupIds || []) {
    try {
      const group = await getGroup(groupId);
      if (!group) throw new Error('Unknown group');
      if (!(group.videoIds || []).includes(id)) {
        await updateGroup(groupId, { videoIds: [...(group.videoIds || []), id] });
      }
      granted.push(groupId);
    } catch (e) {
      console.error('Could not grant an uploaded video to a group:', e);
      failed.push(groupId);
    }
  }
  return { granted, failed };
}

// Called when videos are deleted — the video-level twin of
// pruneCollectionFromGroups, for the same no-orphans reason. It matters more
// now that uploads grant groups: cancelling an upload deletes the half-made
// video, and without this every cancelled upload left its id in the groups
// it was ticked into. Best-effort, like its twin.
export async function pruneVideosFromGroups(videoIds) {
  const gone = new Set((videoIds || []).map(String).filter(Boolean));
  if (!gone.size) return 0;
  try {
    const all = (await redis.hgetall(k(GROUPS_KEY))) || {};
    const touched = Object.values(all)
      .map(parseRecord)
      .filter((g) => g && (g.videoIds || []).some((v) => gone.has(v)));
    for (const group of touched) {
      await updateGroup(group.id, { videoIds: group.videoIds.filter((v) => !gone.has(v)) });
    }
    return touched.length;
  } catch (e) {
    console.error('Could not clear deleted videos from group grants:', e);
    return 0;
  }
}

export async function deleteGroup(groupId) {
  const id = String(groupId);
  const group = await getGroup(id);
  if (!group) throw new Error('Unknown group');

  // Clear the reverse index first. If this half-completes, a member is left
  // pointing at a group id that no longer resolves — resolveAccess() ignores
  // unknown ids, so the worst case is a stale pointer that widens access
  // back toward the default, never one that silently locks someone out.
  const members = (await redis.smembers(membersKey(id))) || [];
  await Promise.all(members.map((email) => redis.srem(userGroupsKey(email), id)));
  await redis.del(membersKey(id));
  await redis.hdel(k(GROUPS_KEY), id);
  return { ok: true, removedMembers: members.length };
}

// Splits a list of addresses into the ones that may be added and the ones
// that may not. PURE, so the caller can report what happened to every address
// it was given rather than just handing back the survivors.
//
// `approved` is the set of currently-approved viewers. An address outside it
// is REFUSED and reported: group membership gates what a viewer sees, so a
// membership for somebody with no account is a row nothing reads, nothing
// cleans, and which becomes real the day that address is approved. Passing
// null means "could not check" and skips the rule, so a Redis blip fails
// toward today's behaviour rather than refusing everyone.
export function planGroupAdditions(emails, approved = null) {
  const seen = new Set();
  const eligible = [];
  const unknown = [];
  const invalid = [];

  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = normalizeEmail(raw);
    if (!email) {
      const text = String(raw ?? '').trim();
      if (text) invalid.push(text);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    // Shape check shared with /api/admin/viewers — see lib/auth.js.
    if (!isLikelyEmail(email)) {
      invalid.push(email);
      continue;
    }
    if (approved && !approved.has(email)) unknown.push(email);
    else eligible.push(email);
  }

  return { eligible: eligible.sort(), unknown: unknown.sort(), invalid: [...new Set(invalid)].sort() };
}

export async function addGroupMembers(groupId, emails, { approved = null } = {}) {
  const id = String(groupId);
  const group = await getGroup(id);
  if (!group) throw new Error('Unknown group');

  const plan = planGroupAdditions(emails, approved);
  if (!plan.eligible.length) return { added: [], ...plan };

  await redis.sadd(membersKey(id), ...plan.eligible);
  await Promise.all(plan.eligible.map((email) => redis.sadd(userGroupsKey(email), id)));
  return { added: plan.eligible, ...plan };
}

export async function removeGroupMember(groupId, email) {
  const id = String(groupId);
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');
  await redis.srem(membersKey(id), e);
  await redis.srem(userGroupsKey(e), id);
  return { ok: true };
}

// Drop a viewer from every group. Called when a viewer is removed entirely,
// so their group memberships don't linger as orphans (weak point #3).
export async function removeUserFromAllGroups(email) {
  const e = normalizeEmail(email);
  if (!e) return { removed: 0 };
  const ids = (await redis.smembers(userGroupsKey(e))) || [];
  await Promise.all(ids.map((id) => redis.srem(membersKey(id), e)));
  await redis.del(userGroupsKey(e));
  return { removed: ids.length };
}

// --- Access resolution ------------------------------------------------

// The unrestricted access object: what every viewer got before groups, and
// what a viewer in zero groups still gets.
export const UNRESTRICTED = Object.freeze({
  restricted: false,
  groupIds: [],
  collectionIds: [],
  videoIds: [],
});

// Resolve what one viewer may see. `staff` short-circuits: admins and
// managers always get UNRESTRICTED.
//
// A Redis failure here degrades to UNRESTRICTED — the same fail-open posture
// as lib/ratelimit.js, and for the same reason. Groups are a curation
// feature layered on top of the approved-viewer check that has ALREADY run
// by the time this is called; an Upstash blip must not blank the library for
// people who are legitimately approved. This widens visibility during an
// outage; it can never let an unapproved account in.
export async function resolveAccess(email, { staff = false } = {}) {
  if (staff) return UNRESTRICTED;
  const e = normalizeEmail(email);
  if (!e) return UNRESTRICTED;

  let groupIds = [];
  try {
    groupIds = (await redis.smembers(userGroupsKey(e))) || [];
  } catch {
    return UNRESTRICTED;
  }
  if (!groupIds.length) return UNRESTRICTED;

  let all;
  try {
    all = (await redis.hgetall(k(GROUPS_KEY))) || {};
  } catch {
    return UNRESTRICTED;
  }

  const collectionIds = new Set();
  const videoIds = new Set();
  const resolved = [];
  for (const id of groupIds) {
    const group = parseRecord(all[id]);
    if (!group) continue; // stale pointer to a deleted group — ignore
    resolved.push(id);
    for (const c of group.collectionIds) collectionIds.add(c);
    for (const v of group.videoIds) videoIds.add(v);
  }

  // Every group they pointed at is gone: treat them as ungrouped rather than
  // as restricted-to-nothing.
  if (!resolved.length) return UNRESTRICTED;

  return {
    restricted: true,
    groupIds: resolved,
    collectionIds: [...collectionIds],
    videoIds: [...videoIds],
  };
}

// --- Pure helpers (no Redis; unit-tested in lib/__tests__/groups.test.js) ---

// A Bunny video object carries `guid` and `collectionId`. An unrestricted
// access object matches everything.
export function canSeeVideo(access, video) {
  if (!access || !access.restricted) return true;
  if (!video) return false;
  if (video.guid && access.videoIds.includes(video.guid)) return true;
  return Boolean(video.collectionId) && access.collectionIds.includes(video.collectionId);
}

export function filterVideos(access, videos) {
  if (!access || !access.restricted) return videos || [];
  return (videos || []).filter((v) => canSeeVideo(access, v));
}

// Collections shown in the homepage filter. A restricted viewer sees the
// collections their groups grant — never a collection they'd get an empty
// list from.
export function filterCollections(access, collections) {
  if (!access || !access.restricted) return collections || [];
  return (collections || []).filter((c) => access.collectionIds.includes(c.id));
}
