import { getSession } from '../../lib/auth0';
import { redis, k } from '../../lib/redis';
import { getRole, roleHasCapability, ROLE_ADMIN, ROLE_MANAGER } from '../../lib/roles';
import { isVerified } from '../../lib/verification';
import { resolveAccess, canSeeVideo } from '../../lib/groups';
import { getSchedule, isVisibleFor } from '../../lib/schedule';
import { isGeoAllowed } from '../../lib/geo';
import { allowWriting, callerId } from '../../lib/ratelimit';
import { getVideoById } from '../../lib/bunny';
import { logAudit } from '../../lib/audit';
import { cleanCommentText, commentView, displayName } from '../../lib/comments';
import { addComment, deleteComment, getComment, listComments } from '../../lib/commentsStore';
import { withMonitorApi } from '../../lib/monitor';

// Comments under a video.
//
//   GET    ?videoId=...             -> { comments: [...] }, oldest first
//   POST   { videoId, text }        -> { comment } — added as the caller
//   DELETE ?videoId=...&id=...      -> removes one comment
//
// GATED LIKE WATCHING — the same checks, in the same order, as
// pages/watch/video/[id].js: approved viewer or staff, region, verified email
// (when enforced), the video must exist, group grants (canSeeVideo), and —
// for reading and writing, staff exempt — the publish window. Every refusal
// after sign-in is the same 404, so the route cannot probe which ids exist.
// Deleting your own comment skips only the window: a viewer can always take
// back what they said.
//
// IDENTITY COMES FROM THE SESSION. No request field names a person; "is this
// mine?" is decided by the stored email. Other viewers see a display name only
// (lib/comments.js); the email is shown solely to staff who can manage the
// viewer list (viewers:manage). Deleting someone else's comment needs
// comments:manage (admins and managers) and is audited. Decision 19 in the
// architecture contract.
async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req, res);
  if (!session?.user?.email) return res.status(401).json({ error: 'Not signed in' });
  const email = session.user.email.toLowerCase();

  const [approved, role] = await Promise.all([redis.sismember(k('approved_viewers'), email), getRole(email)]);
  const staff = role === ROLE_ADMIN || role === ROLE_MANAGER;
  if (!approved && !staff) return res.status(403).json({ error: 'Not approved' });
  if (!(await isGeoAllowed(req, email, staff))) {
    return res.status(403).json({ error: 'Not available in your region' });
  }
  if (!(await isVerified(session, { staff }))) {
    return res.status(403).json({ error: 'Please verify your email address' });
  }

  // typeof, not coercion: a repeated parameter arrives as an array.
  const raw = req.method === 'POST' ? req.body?.videoId : req.query.videoId;
  if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'videoId required' });

  let video;
  try {
    video = await getVideoById(raw.trim());
  } catch {
    // An id that is not a guid, or bunny refusing: either way, not found.
    return res.status(404).json({ error: 'Not found' });
  }
  if (!video?.guid) return res.status(404).json({ error: 'Not found' });
  const access = await resolveAccess(email, { staff });
  if (!canSeeVideo(access, video)) return res.status(404).json({ error: 'Not found' });

  const canModerate = roleHasCapability(role, 'comments:manage');
  const viewOptions = { email, canModerate, canSeeEmails: roleHasCapability(role, 'viewers:manage') };
  const inWindow = async () => staff || isVisibleFor(await getSchedule(video.guid), access.groupIds);

  if (req.method === 'GET') {
    if (!(await inWindow())) return res.status(404).json({ error: 'Not found' });
    try {
      const comments = await listComments(video.guid);
      return res.json({ comments: comments.map((c) => commentView(c, viewOptions)) });
    } catch (e) {
      console.error('Could not read comments:', e);
      return res.status(502).json({ error: 'Could not load comments' });
    }
  }

  // Text other viewers will read: the writing limiter (30 an hour), not the
  // flood guard the other viewer routes use (lib/ratelimit.js).
  if (!(await allowWriting(callerId(req, session, 'comment')))) {
    return res.status(429).json({ error: 'Too many comments — try again later' });
  }

  if (req.method === 'POST') {
    if (!(await inWindow())) return res.status(404).json({ error: 'Not found' });
    const cleaned = cleanCommentText(req.body?.text);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
    try {
      const result = await addComment(video.guid, {
        email,
        name: displayName(session.user.name, email),
        text: cleaned.text,
      });
      if (!result.ok) return res.status(409).json({ error: 'This video has reached its comment limit' });
      return res.json({ comment: commentView(result.comment, viewOptions) });
    } catch (e) {
      console.error('Could not save a comment:', e);
      return res.status(502).json({ error: 'Could not save your comment' });
    }
  }

  // DELETE
  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  let comment;
  try {
    comment = await getComment(video.guid, id);
  } catch (e) {
    console.error('Could not read a comment:', e);
    return res.status(502).json({ error: 'Could not delete the comment' });
  }
  if (!comment) return res.status(404).json({ error: 'Not found' });
  const mine = comment.email === email;
  if (!mine && !canModerate) {
    return res.status(403).json({ error: 'You can only delete your own comments' });
  }
  try {
    await deleteComment(video.guid, comment.id);
  } catch (e) {
    console.error('Could not delete a comment:', e);
    return res.status(502).json({ error: 'Could not delete the comment' });
  }
  if (!mine) await logAudit(email, 'comment.delete', `${video.guid}: a comment by ${comment.name}`);
  return res.json({ ok: true });
}

export default withMonitorApi(handler);
