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
