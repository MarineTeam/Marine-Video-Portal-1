import { getSession } from '@auth0/nextjs-auth0';
import { redis, k } from '../../../lib/redis';
import { isAdmin } from '../../../lib/auth';
import { logAudit } from '../../../lib/audit';

const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical limit

// Plain string ops instead of a single regex: the previous
// /^[^\s@]+@[^\s@]+\.[^\s@]+$/ didn't exclude '.' from its char classes, so
// the boundary before the literal '.' was ambiguous — a crafted string in a
// bulk-paste input could cause polynomial-time backtracking. This is linear.
function isLikelyEmail(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const emails = await redis.smembers(k('approved_viewers'));
    const sorted = (emails || []).sort();
    const seen = (await redis.hgetall(k('viewer_last_seen'))) || {};
    return res.json(
      sorted.map((email) => ({ email, lastSeen: seen[email] ? Number(seen[email]) : null }))
    );
  }

  if (req.method === 'POST') {
    const { email, emails } = req.body || {};
    // Accept a single email, an array, or a newline/comma-separated string (bulk add).
    let list = [];
    if (Array.isArray(emails)) list = emails;
    else if (typeof emails === 'string') list = emails.split(/[\s,;]+/);
    else if (email) list = [email];

    const clean = [
      ...new Set(list.map((e) => String(e).toLowerCase().trim()).filter(isLikelyEmail)),
    ];
    if (clean.length === 0) return res.status(400).json({ error: 'No valid emails provided' });

    await redis.sadd(k('approved_viewers'), ...clean);
    await logAudit(actor, 'viewer.add', clean.join(', '));
    return res.json({ ok: true, added: clean.length });
  }

  if (req.method === 'DELETE') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const e = email.toLowerCase().trim();
    await redis.srem(k('approved_viewers'), e);
    await redis.hdel(k('viewer_last_seen'), e);
    await logAudit(actor, 'viewer.remove', e);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
