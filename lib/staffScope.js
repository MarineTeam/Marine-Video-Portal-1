// Group-scoped staff: the route helpers that need Redis or bunny.
//
// The rules are pure (lib/staffScopeRules.js); storage is
// lib/staffScopeStore.js; the caller's scope and content are resolved once in
// lib/roles.js getAccess() and carried on requireCapability's result. Every
// helper here fails CLOSED — an error reads as "not in scope".
import { getVideoById } from './bunny';
import { loadGroupsById } from './groups';
import { getShares } from './shareBundle';
import { isScoped, mayDeleteVideo, videoInScope } from './staffScopeRules';

export const SCOPED_REFUSAL = "Your access is limited to certain groups, so you can't do that";

// The guids, of those given, a scoped caller may touch. A guid the scope
// names directly needs no lookup; any other is looked up once, because a
// video can be in scope through its collection. All of them for an unscoped
// caller.
export async function guidsInScope(auth, guids) {
  const list = [...new Set((guids || []).map(String).filter(Boolean))];
  if (!isScoped(auth)) return new Set(list);
  const scope = auth.contentScope || { videoIds: [], collectionIds: [] };
  const out = new Set(list.filter((g) => scope.videoIds.includes(g)));
  const rest = list.filter((g) => !out.has(g));
  if (rest.length && scope.collectionIds.length) {
    await Promise.all(
      rest.map(async (guid) => {
        try {
          const video = await getVideoById(guid);
          if (videoInScope(auth, video)) out.add(guid);
        } catch {
          // Unknown or unreadable: out of scope.
        }
      })
    );
  }
  return out;
}

export async function guidInScope(auth, guid) {
  return (await guidsInScope(auth, [guid])).has(String(guid || ''));
}

// Why a scoped caller may not delete this video, as { status, error }, or
// null when they may (always null for an unscoped caller).
export async function scopedDeleteProblem(auth, guid) {
  if (!isScoped(auth)) return null;
  let video;
  let groupsById;
  try {
    [video, groupsById] = await Promise.all([getVideoById(guid), loadGroupsById()]);
  } catch {
    return { status: 404, error: 'Video not found' };
  }
  if (!video?.guid || !videoInScope(auth, video)) return { status: 404, error: 'Video not found' };
  if (!mayDeleteVideo(auth, video, groupsById)) {
    return {
      status: 403,
      error: 'Another group can also see this video, so only someone without a group limit can delete it',
    };
  }
  return null;
}

// The share ids a scoped caller may not touch: links to videos outside their
// scope, and ids naming no link. Empty for an unscoped caller. Callers refuse
// the whole request when this is non-empty — the Shares tab only ever offers
// in-scope links, so a mixed list is a crafted one.
export async function shareIdsOutsideScope(auth, ids) {
  if (!isScoped(auth) || !ids.length) return [];
  const shares = await getShares(ids);
  const byId = new Map(shares.map((s) => [s.shareId, s]));
  const allowed = await guidsInScope(auth, shares.map((s) => s.videoId));
  return ids.filter((id) => !byId.has(id) || !allowed.has(byId.get(id).videoId));
}
