// Redis side of per-viewer playback progress: k(`progress:${email}`), a hash of
// videoId -> { seconds, duration, title, at }. Rules in lib/progress.js.
import { redis, k } from './redis';
import { MAX_PROGRESS_ENTRIES, progressToEvict } from './progress';

// Saves one video's position, in one command on the common path: the script
// writes when the video already has an entry or the hash is under the cap, and
// otherwise answers 0 WITHOUT writing. Only then — a new video at the cap —
// does this read the hash, drop the least recently watched entries, and write.
// That slow path is not atomic with the check, so two first-time saves racing
// at the cap can leave the hash one or two over it; the next save trims it back.
const SAVE_PROGRESS_SCRIPT = `
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 or redis.call("HLEN", KEYS[1]) < tonumber(ARGV[3]) then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;

export async function saveProgress(email, videoId, entry) {
  const key = k(`progress:${email}`);
  const saved = await redis.eval(
    SAVE_PROGRESS_SCRIPT,
    [key],
    [videoId, JSON.stringify(entry), String(MAX_PROGRESS_ENTRIES)]
  );
  if (Number(saved) === 1) return;
  const evict = progressToEvict((await redis.hgetall(key)) || {}, MAX_PROGRESS_ENTRIES);
  if (evict.length) await redis.hdel(key, ...evict);
  await redis.hset(key, { [videoId]: entry });
}
