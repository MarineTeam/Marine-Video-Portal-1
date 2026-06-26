import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import crypto from 'crypto';
import { isAdmin } from '../../../lib/auth';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  const { videoId, title, email, expiresInHours = 72 } = req.body || {};
  if (!videoId || !email) return res.status(400).json({ error: 'videoId and email are required' });

  const shareId = crypto.randomUUID();
  const ttlSeconds = Math.min(expiresInHours, 720) * 3600; // capped at 30 days
  const expiresAt = Date.now() + ttlSeconds * 1000;

  await redis.set(
    `share:${shareId}`,
    { videoId, title, email: email.toLowerCase().trim(), expiresAt },
    { ex: ttlSeconds }
  );
  await redis.sadd('active_shares', shareId);
  const watchUrl = `${process.env.AUTH0_BASE_URL}/watch/${shareId}`;
  res.json({ watchUrl, expiresInHours });
}
