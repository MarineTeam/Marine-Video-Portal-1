// The two Lua scripts that keep rating totals equal to the votes.
//
// Before these, a vote and its counter were two separate writes: the vote
// first, then a best-effort HINCRBY. A failure between them left the total one
// short for good, and two clicks racing each other both read "no previous
// vote" and both incremented. Redis runs a script as one command — nothing
// else touches either hash while it runs — so the read of the previous vote,
// the vote itself and both counter moves now happen together or not at all.
//
// Kept in a module of their own, with no imports, so the tests can run the
// exact strings against a real redis-server (lib/__tests__/ratingScripts.test.js)
// rather than against a mock that would agree with whatever it was told.
//
// The field layout is the one lib/ratings.js documents: the vote lives at
// pvp:ratings:{email} -> videoId -> 'up' | 'down', the totals at
// pvp:rating_counts -> '<videoId>:up' / '<videoId>:down' -> integer.

// KEYS[1]  the viewer's ratings hash
// KEYS[2]  the counters hash
// ARGV[1]  video id
// ARGV[2]  'up', 'down', or '' to clear
//
// Returns 1 when something changed, 0 for a no-op. A stored value that is not
// exactly 'up' or 'down' reads as no vote, matching normalizeVote(): it is
// overwritten by a real vote without decrementing anything, and a clear leaves
// it alone — the same answers the old read-then-write path gave.
export const VOTE_SCRIPT = `
local id = ARGV[1]
local nextVote = ARGV[2]
if nextVote ~= 'up' and nextVote ~= 'down' then nextVote = false end
local prev = redis.call('HGET', KEYS[1], id)
if prev ~= 'up' and prev ~= 'down' then prev = false end
if prev == nextVote then return 0 end
if nextVote then
  redis.call('HSET', KEYS[1], id, nextVote)
else
  redis.call('HDEL', KEYS[1], id)
end
if prev then redis.call('HINCRBY', KEYS[2], id .. ':' .. prev, -1) end
if nextVote then redis.call('HINCRBY', KEYS[2], id .. ':' .. nextVote, 1) end
return 1
`;

// KEYS[1]     the counters hash
// KEYS[2..n]  every viewer's ratings hash
//
// Rebuilds the counters from the votes and REPLACES them, so drift from before
// VOTE_SCRIPT existed is corrected rather than carried forward. Returns
// { votes counted, counter fields written }.
//
// Atomic for the same reason: a vote landing halfway through a recount would
// otherwise be counted by the script and then again by its own HINCRBY. A
// viewer whose hash did not exist when the key list was taken is the one gap —
// their first vote can land between the scan and this script and be dropped
// from the rebuilt total. It is a one-vote, self-evident window, and the next
// recount closes it.
//
// HSET is sent in slices because unpack() on a very large table can exceed
// Lua's C stack; 200 field/value pairs per call is far below that limit.
export const RECOUNT_SCRIPT = `
local totals = {}
local votes = 0
for i = 2, #KEYS do
  local flat = redis.call('HGETALL', KEYS[i])
  for j = 1, #flat, 2 do
    local v = flat[j + 1]
    if v == 'up' or v == 'down' then
      local field = flat[j] .. ':' .. v
      totals[field] = (totals[field] or 0) + 1
      votes = votes + 1
    end
  end
end
redis.call('DEL', KEYS[1])
local args = {}
for field, n in pairs(totals) do
  args[#args + 1] = field
  args[#args + 1] = n
end
for i = 1, #args, 400 do
  redis.call('HSET', KEYS[1], unpack(args, i, math.min(i + 399, #args)))
end
return { votes, #args / 2 }
`;
