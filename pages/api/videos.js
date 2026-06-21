import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getEmbedUrl } from '../../lib/bunny';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const limit = parseInt(req.query.limit) || 2;
  const videos = await listVideos({ itemsPerPage: limit });

  const result = videos.map((v) => ({
    id: v.guid,
    title: v.title,
    embedUrl: getEmbedUrl(v.guid, 3600), // valid 1 hour
  }));

  res.json(result);
}