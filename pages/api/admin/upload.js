import { getSession } from '@auth0/nextjs-auth0';
import { createVideo, signTusUpload } from '../../../lib/bunny';
import { isAdmin } from '../../../lib/auth';
import { allow, callerId } from '../../../lib/ratelimit';

// Creates the Bunny video record and returns a signed TUS authorization so the
// browser can upload the file bytes directly to Bunny. The API key stays server-side.
export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  if (!(await allow(callerId(req, session, 'upload')))) {
    return res.status(429).json({ error: 'Too many requests — slow down.' });
  }

  const { title } = req.body || {};
  const cleanTitle = (title || '').trim() || 'Untitled';

  try {
    const videoId = await createVideo(cleanTitle);
    const { libraryId, signature, expires } = signTusUpload(videoId);
    res.json({ videoId, libraryId, signature, expires, title: cleanTitle });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to create video' });
  }
}
