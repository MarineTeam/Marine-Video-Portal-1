import { Redis } from '@upstash/redis';
import { monitorEnabled, recordQuery } from './monitor';

// Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN once you connect a
// Storage database to this project. If the dashboard shows different
// names (e.g. UPSTASH_REDIS_REST_URL), use those instead.
const rawRedis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Query Monitor instrumentation: a transparent pass-through Proxy that times
// every Redis command and reports it via lib/monitor.js. Disabled (the
// default), this adds one cheap env-var check per call and nothing else —
// every existing `redis.foo(...)` call site is untouched.
export const redis = new Proxy(rawRedis, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function') return value;
    return function (...args) {
      if (!monitorEnabled()) return value.apply(target, args);
      const start = process.hrtime.bigint();
      const finish = () => recordQuery(String(prop), Number(process.hrtime.bigint() - start) / 1e6);
      const result = value.apply(target, args);
      if (result && typeof result.then === 'function') {
        return result.finally(finish);
      }
      finish();
      return result;
    };
  },
});

const PREFIX = 'pvp:'; // private-video-portal — change this if you ever rename the app

export function k(key) {
  return `${PREFIX}${key}`;
}
