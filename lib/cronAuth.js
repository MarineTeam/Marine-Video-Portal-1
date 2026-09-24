// Who may call a scheduled-job route: Vercel's cron runner, and nobody else.
//
// Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron invocation
// when the project has a CRON_SECRET environment variable. A cron route is
// reachable from the internet like any other, so that header is the ONLY
// thing standing between a stranger and the job — hence:
//
//   * no secret configured -> the route does not exist (404). Inert until
//     configured, like push and email: deploying this changes nothing.
//   * a secret shorter than 16 characters is treated as not configured, and
//     says so in the logs — Vercel's own guidance is 16 or more, and a short
//     one is guessable.
//   * the comparison is constant-time over fixed-length digests, so response
//     timing says nothing about how much of a guess was right.
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_CRON_SECRET_LENGTH = 16;

export function cronSecret(env = process.env) {
  // Trimmed: a value pasted into Vercel with a stray space or newline would
  // otherwise never match, since HTTP strips it from the header Vercel sends.
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) return null;
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    console.error(
      `CRON_SECRET is shorter than ${MIN_CRON_SECRET_LENGTH} characters, so scheduled jobs are switched off.`
    );
    return null;
  }
  return secret;
}

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function isCronAuthorized(header, secret) {
  if (!secret || typeof header !== 'string' || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
