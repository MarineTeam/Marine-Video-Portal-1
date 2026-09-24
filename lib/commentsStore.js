// Storage for comments (rules in lib/comments.js, gate in pages/api/comments.js).
//
//   pvp:comments:<videoId>  hash, comment id -> JSON { id, email, name, text, at }
//
// One hash per VIDEO, because every read is 'this video's comments' and every
// delete names one comment of one video. Bounded per video
// (MAX_COMMENTS_PER_VIDEO), enforced atomically by the add script, and removed
// whole when the video is deleted (pages/api/admin/videos.js DELETE).
//
// Holds the author's email — see lib/comments.js for why, and for who may
// ever see it.
import { redis, k } from './redis';
import { MAX_COMMENTS_PER_VIDEO, commentId, isCommentId, parseComment, sortComments } from './comments';

const commentsKey = (videoId) => k(`comments:${String(videoId)}`);

// Adds one comment unless the video is already at the cap. One script, so two
// comments arriving together cannot both squeeze past the last free slot.
const ADD_SCRIPT = `
if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1
`;

export async function listComments(videoId) {
  const raw = (await redis.hgetall(commentsKey(videoId))) || {};
  return sortComments(Object.values(raw).map(parseComment).filter(Boolean));
}

export async function getComment(videoId, id) {
  if (!isCommentId(id)) return null;
  return parseComment(await redis.hget(commentsKey(videoId), id));
}

// Returns { ok: true, comment } or { ok: false, error: 'full' }.
export async function addComment(videoId, { email, name, text }, now = Date.now()) {
  const comment = { id: commentId(now), email, name, text, at: now };
  const added = await redis.eval(
    ADD_SCRIPT,
    [commentsKey(videoId)],
    [comment.id, JSON.stringify(comment), String(MAX_COMMENTS_PER_VIDEO)]
  );
  if (Number(added) !== 1) return { ok: false, error: 'full' };
  return { ok: true, comment: parseComment(comment) };
}

export async function deleteComment(videoId, id) {
  if (!isCommentId(id)) return;
  await redis.hdel(commentsKey(videoId), id);
}

// Every comment on a video, for when the video itself is deleted.
export async function clearComments(videoId) {
  await redis.del(commentsKey(videoId));
}
