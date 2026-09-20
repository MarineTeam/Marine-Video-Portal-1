import { requireCapability } from '../../../lib/roles';
import { redis, k } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { removeUserFromAllGroups } from '../../../lib/groups';
import { clearTokenForEmail } from '../../../lib/feedTokens';
import { isLikelyEmail } from '../../../lib/auth';

const MAX_TAGS_PER_VIEWER = 20;
const MAX_TAG_LENGTH = 40;

function parseStoredTags(raw) {
  if (!raw) return [];
  try {
    // Upstash auto-deserializes JSON-looking strings on read, so `raw` may
    // already be the parsed array rather than the JSON string we stored.
    return cleanTags(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    return [];
  }
}

function cleanTags(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((t) => String(t).trim())
        .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH)
    ),
  ].slice(0, MAX_TAGS_PER_VIEWER);
}

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'viewers:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    const emails = await redis.smembers(k('approved_viewers'));
    const sorted = (emails || []).sort();
    const seen = (await redis.hgetall(k('viewer_last_seen'))) || {};
    const tags = (await redis.hgetall(k('viewer_tags'))) || {};
    return res.json(
      sorted.map((email) => ({
        email,
        lastSeen: seen[email] ? Number(seen[email]) : null,
        tags: parseStoredTags(tags[email]),
      }))
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

  if (req.method === 'PATCH') {
    const { email, tags } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const e = String(email).toLowerCase().trim();
    const isViewer = await redis.sismember(k('approved_viewers'), e);
    if (!isViewer) return res.status(404).json({ error: 'Unknown viewer' });

    const clean = cleanTags(tags);
    if (clean.length > 0) {
      await redis.hset(k('viewer_tags'), { [e]: JSON.stringify(clean) });
    } else {
      await redis.hdel(k('viewer_tags'), e);
    }
    await logAudit(actor, 'viewer.tags', `${e} → ${clean.join(', ') || '(cleared)'}`);
    return res.json({ ok: true, email: e, tags: clean });
  }

  if (req.method === 'DELETE') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const e = email.toLowerCase().trim();
    await redis.srem(k('approved_viewers'), e);
    await redis.hdel(k('viewer_last_seen'), e);
    await redis.hdel(k('viewer_tags'), e);
    // Drop their group memberships too, so removal doesn't leave an orphan
    // entry that would silently re-restrict them if they're ever re-added.
    await removeUserFromAllGroups(e);
    // Their podcast feed token dies with their access. The feed route also
    // re-checks the approved set on every fetch, so this is belt-and-braces
    // rather than the only thing stopping them.
    await clearTokenForEmail(e);
    await logAudit(actor, 'viewer.remove', e);
    return res.json({ ok: true });
  }

  res.status(405).end();
}

export default withMonitorApi(handler);
