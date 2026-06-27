import { Redis } from '@upstash/redis';

// Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN once you connect a
// Storage database to this project. If the dashboard shows different
// names (e.g. UPSTASH_REDIS_REST_URL), use those instead.
export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const PREFIX = 'pvp:'; // private-video-portal — change this if you ever rename the app

export function k(key) {
  return `${PREFIX}${key}`;
