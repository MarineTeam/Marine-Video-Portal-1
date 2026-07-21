import { getSession } from '@auth0/nextjs-auth0';
import { getShare, saveShare, isExpired } from '../../../../lib/shareBundle';

// Records real playback signal from the Bunny player (player.js events) on a
// share link, as opposed to a mere page view: play count, furthest progress
// reached, and whether the video was watched to completion. Gated exactly
// like the watch page itself — only the recipient the link was issued to may
// report progress on it.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { shareId } = req.query;
  const share = await getShare(shareId);
  if (!share || isExpired(share)) {
    return res.status(404).json({ error: 'Link has expired or does not exist.' });
  }
  if (share.email !== session.user.email.toLowerCase()) {
    return res.status(403).json({ error: "This link isn't valid for your account." });
  }

  const { type, pct } = req.body || {};
  const updated = { ...share };

  if (type === 'play') {
    updated.plays = (share.plays || 0) + 1;
    updated.lastPlayAt = Date.now();
  } else if (type === 'progress') {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    updated.furthestPct = Math.max(share.furthestPct || 0, p);
  } else if (type === 'completed') {
    updated.furthestPct = 100;
    if (!share.completed) {
      updated.completed = true;
      updated.completedAt = Date.now();
    }
  } else {
    return res.status(400).json({ error: 'Unknown event type' });
  }

  await saveShare(shareId, updated);
  res.json({ ok: true });
}
