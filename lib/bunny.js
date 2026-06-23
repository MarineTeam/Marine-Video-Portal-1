import crypto from 'crypto';

const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';

export async function listVideos({ itemsPerPage = 100 } = {}) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos?page=1&itemsPerPage=${itemsPerPage}&orderBy=date`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY } }
  );
  if (!res.ok) throw new Error(`Bunny API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

export function signVideoToken(videoId, expiresInSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const hashable = `${process.env.BUNNY_TOKEN_AUTH_KEY}${videoId}${expires}`;
  const token = crypto.createHash('sha256').update(hashable).digest('hex');
  return { token, expires };
}

export function getEmbedUrl(videoId, expiresInSeconds = 3600) {
  const { token, expires } = signVideoToken(videoId, expiresInSeconds);
  return `https://iframe.mediadelivery.net/embed/${process.env.BUNNY_LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}&autoplay=false`;
}
