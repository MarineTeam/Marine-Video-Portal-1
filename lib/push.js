import webpush from 'web-push';
import { redis, k } from './redis';
import { getSiteName } from './brandingStore';

// Web Push (VAPID) helper. The whole feature is INERT unless both VAPID keys are
// present, so a deployment without them behaves exactly as before — no buttons,
// no sends, no errors. web-push is only ever imported by server-side API routes,
// never into the client bundle.
const PUBLIC_KEY = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();

export function pushEnabled() {
  return Boolean(PUBLIC_KEY && PRIVATE_KEY);
}

// Configure web-push lazily, inside request handling — never at module load, so
// an absent/short key can't throw during `next build` (which imports API routes).
let configured = false;
function configure() {
  if (configured) return;
  const firstAdmin = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  const subject =
    (process.env.VAPID_SUBJECT || '').trim() ||
    (firstAdmin ? `mailto:${firstAdmin}` : 'mailto:admin@example.com');
  webpush.setVapidDetails(subject, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
}

function subsKey(email) {
  return k(`push_subs:${email}`);
}

// The set of emails a broadcast may reach: currently-approved viewers plus
// admins. Enumerating from the live approved set means a removed viewer stops
// receiving notifications even if their subscription still lingers in Redis.
export async function targetEmails() {
  const approved = (await redis.smembers(k('approved_viewers'))) || [];
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...approved.map((e) => String(e).toLowerCase()), ...admins])];
}

// Send a payload to every stored subscription for the given emails. Dead
// subscriptions (HTTP 404/410 from the push service) are pruned as we go.
export async function sendToEmails(emails, payload) {
  if (!pushEnabled()) return { sent: 0, pruned: 0 };
  configure();
  const data = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  for (const email of emails) {
    const subs = (await redis.hgetall(subsKey(email))) || {};
    for (const [endpoint, raw] of Object.entries(subs)) {
      let sub;
      try {
        sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        continue;
      }
      if (!sub || !sub.endpoint) continue;
      try {
        await webpush.sendNotification(sub, data);
        sent++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          await redis.hdel(subsKey(email), endpoint);
          pruned++;
        }
      }
    }
  }
  return { sent, pruned };
}

// A video is announce-worthy when it's finished encoding (Bunny status 4) and was
// uploaded recently. The freshness gate stops a first run (or newly-enabled push)
// from back-blasting every already-ready video in the library.
const FRESH_MS = 24 * 60 * 60 * 1000;
export function isFreshReady(video, now = Date.now()) {
  if (!video || video.status !== 4 || !video.guid) return false;
  const uploaded = video.dateUploaded ? new Date(video.dateUploaded).getTime() : 0;
  if (!uploaded || Number.isNaN(uploaded)) return false;
  return now - uploaded <= FRESH_MS;
}

// Announce any newly-ready videos exactly once. The atomic guard is SADD's
// return value: it reports 1 only for the caller that first inserts the guid, so
// concurrent admin polls (or multiple admins) never double-notify.
export async function maybeAnnounceReady(videos) {
  if (!pushEnabled() || !Array.isArray(videos)) return;
  const now = Date.now();
  for (const v of videos) {
    if (!isFreshReady(v, now)) continue;
    const added = await redis.sadd(k('announced_videos'), v.guid);
    if (added === 1) {
      const emails = await targetEmails();
      await sendToEmails(emails, {
        title: `New video on ${await getSiteName()}`,
        body: v.title || 'A new video is ready to watch',
        url: `/watch/video/${v.guid}`,
      });
    }
  }
}
