import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import crypto from 'crypto';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  const { videoId, title, email, expiresInHours = 72 } = req.body || {};
  if (!videoId || !email) return res.status(400).json({ error: 'videoId and email are required' });

  const shareId = crypto.randomUUID();
  const ttlSeconds = Math.min(expiresInHours, 720) * 3600; // capped at 30 days

  await redis.set(
    `share:${shareId}`,
    { videoId, title, email: email.toLowerCase().trim() },
    { ex: ttlSeconds }
  );

  const watchUrl = `${process.env.AUTH0_BASE_URL}/watch/${shareId}`;
  res.json({ watchUrl, expiresInHours });
}