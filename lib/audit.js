import { redis, k } from './redis';

const AUDIT_KEY = k('audit_log');
const MAX_ENTRIES = 200;

// Record an admin action. Never throws — auditing must not break the action it logs.
export async function logAudit(actor, action, detail = '') {
  try {
    await redis.lpush(AUDIT_KEY, { at: Date.now(), actor: actor || 'unknown', action, detail });
    await redis.ltrim(AUDIT_KEY, 0, MAX_ENTRIES - 1);
  } catch (e) {
    // swallow
  }
}

export async function getAudit(limit = 100) {
  const entries = await redis.lrange(AUDIT_KEY, 0, limit - 1);
  return Array.isArray(entries) ? entries : [];
}
