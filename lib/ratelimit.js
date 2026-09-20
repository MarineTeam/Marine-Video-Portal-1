import { Ratelimit } from '@upstash/ratelimit';
import { redis, k } from './redis';

// One sliding-window limiter reused across routes. The identifier embeds a
// per-route bucket so each endpoint gets its own window per caller.
const limiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '10 s'),
  prefix: k('rl'),
  analytics: false,
});

// Best-effort caller identity: logged-in email, else client IP, else "anon".
export function callerId(req, session, bucket) {
  const who =
    session?.user?.email ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'anon';
  return `${bucket}:${who}`;
}

// A SECOND limiter, for endpoints that spend money rather than merely cost a
// request. The shared one above is 60 per 10 seconds — a flood guard, which is
// the right instrument for a Redis read and the wrong one for a paid external
// API: at bunny's transcription price of $0.10 per minute of video, 60 calls
// in 10 seconds is a four-figure mistake made faster than anyone can react.
//
// Same fail-open posture as `allow`, deliberately. Failing closed here would
// let an Upstash hiccup block an admin from a job they are entitled to run,
// and the capability check in front of the route is the real access control —
// this is a brake, not a gate.
const costlyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 h'),
  prefix: k('rl-costly'),
  analytics: false,
});

export async function allowCostly(identifier) {
  try {
    const { success } = await costlyLimiter.limit(identifier);
    return success;
  } catch (e) {
    return true;
  }
}

// Returns true if allowed, false if the caller has exceeded the window.
// Fails open (returns true) if the limiter backend errors, so real users are
// never blocked by an infrastructure hiccup.
export async function allow(identifier) {
  try {
    const { success } = await limiter.limit(identifier);
    return success;
  } catch (e) {
    return true;
  }
}
