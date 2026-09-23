// Which groups a new upload is granted to, decided BEFORE the video exists.
//
// PURE — no Redis. The upload route calls this with the ids the admin ticked
// and the ids that actually exist, and only creates the bunny.net video if the
// answer is ok. Refusing afterwards would leave an orphan video in the library
// for a request that was never going to be honoured.
//
// Why uploads grant at all: a group whose members are restricted to what it
// grants does not see a new video until someone ticks it into the group, so
// the ordinary result of uploading was "live for everyone except the people
// it was for". Choosing the groups on the upload form closes that at the one
// moment the admin is already thinking about who the video is for.
//
// There is deliberately NO stored "default group for new uploads". A default
// grants silently, on every upload, long after whoever set it has forgotten
// it exists — access that nobody chose on the day. Ticking is explicit, one
// upload at a time, and an unticked form grants nothing, exactly as before.

export const MAX_UPLOAD_GROUPS = 20;

// raw: the request's groupIds, untrusted. knownGroupIds: every group id that
// exists. Returns { ok: true, groupIds } or { ok: false, status, error }.
export function planUploadGrants(raw, knownGroupIds) {
  if (raw === undefined || raw === null) return { ok: true, groupIds: [] };
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    return { ok: false, status: 400, error: 'groupIds must be a list of group ids' };
  }
  const groupIds = [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
  if (groupIds.length > MAX_UPLOAD_GROUPS) {
    return { ok: false, status: 400, error: `At most ${MAX_UPLOAD_GROUPS} groups per upload` };
  }
  const known = new Set(knownGroupIds || []);
  const unknown = groupIds.filter((id) => !known.has(id));
  if (unknown.length) {
    // A group deleted in another tab between loading the form and pressing
    // upload. Refused rather than quietly skipped: the admin believes this
    // video is going to those people, and silently granting fewer groups is
    // how a video ends up invisible to the people it was for.
    return {
      ok: false,
      status: 400,
      error: `${unknown.length} of the chosen groups no longer exist — reload and choose again`,
    };
  }
  return { ok: true, groupIds };
}
