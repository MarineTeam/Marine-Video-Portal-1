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

// Create an empty video object in the library; the bytes are uploaded separately
// (via TUS) by the browser. Returns the new video's guid.
export async function createVideo(title) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos`,
    {
      method: 'POST',
      headers: {
        AccessKey: process.env.BUNNY_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ title }),
    }
  );
  if (!res.ok) throw new Error(`Bunny create-video error: ${res.status}`);
  const data = await res.json();
  return data.guid;
}

// Sign a TUS upload so the browser can stream the file straight to Bunny without
// ever seeing the library API key. Signature = SHA256(libraryId + apiKey + expires + videoId).
export function signTusUpload(videoId, expiresInSeconds = 86400) {
  // Trim env values: a stray newline/space is silently dropped from the AccessKey
  // header (so createVideo still works) but corrupts the SHA256 signature → HTTP 401.
  const libraryId = (process.env.BUNNY_LIBRARY_ID || '').trim();
  const apiKey = (process.env.BUNNY_API_KEY || '').trim();
  // Bunny TUS expects the expiry as a Unix timestamp in SECONDS.
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const signature = crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${expires}${videoId}`)
    .digest('hex');
  return { libraryId, signature, expires };
}

export async function deleteVideo(videoId) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
    { method: 'DELETE', headers: { AccessKey: process.env.BUNNY_API_KEY, accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Bunny delete-video error: ${res.status}`);
  return true;
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