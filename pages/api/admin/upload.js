import { requireCapability } from '../../../lib/roles';
import { createVideo, signTusUpload } from '../../../lib/bunny';
import { allow, callerId } from '../../../lib/ratelimit';
import { withMonitorApi } from '../../../lib/monitor';

// Creates the Bunny video record and returns a signed TUS authorization so the
// browser can upload the file bytes directly to Bunny. The API key stays server-side.
async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;
  const { session } = auth;
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

export default withMonitorApi(handler);
