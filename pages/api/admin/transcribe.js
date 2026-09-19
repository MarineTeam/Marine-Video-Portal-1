import { requireCapability } from '../../../lib/roles';
import { allowCostly, callerId } from '../../../lib/ratelimit';
import { fetchCaptionVtt, getVideoById, transcribeVideo } from '../../../lib/bunny';
import { parseVtt } from '../../../lib/captions';
import { setTranscript } from '../../../lib/captionsStore';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';
import { suggestedChapters } from '../../../lib/aiChapters';

// Queues bunny.net Transcribe AI for one video, and ingests the result.
//
//   POST { videoId }               -> queue transcription (COSTS MONEY, below)
//   POST { videoId, chapters }     -> ...and ask bunny for chapter suggestions
//   POST { videoId, ingest }       -> pull the finished captions into Redis
//   POST { videoId, suggestions }  -> read the suggested chapters back (writes
//                                     NOTHING — see lib/aiChapters.js)
//
// THIS ROUTE SPENDS MONEY. bunny bills $0.10 per minute of video, per
// language, so a 90-minute service is $9 from one request. It therefore uses
// allowCostly (10/hour) rather than the shared `allow` limiter, which is 60
// per 10 seconds — the right instrument for a Redis read and the wrong one
// here by three orders of magnitude.
//
// Transcription is ASYNCHRONOUS: queueing returns immediately and the captions
// appear minutes later. There is no webhook, so ingest is an explicit second
// action rather than a background poller, which keeps the cost and the timing
// visible to whoever pressed the button.
const LANG = /^[A-Za-z0-9-]{2,12}$/;

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  // typeof, not coercion: String(['a','b']) would quietly become 'a,b', an id
  // nobody sent. Bunny's own GUID check in lib/bunny.js rejects it either way,
  // but a 400 here is a better answer than a thrown 'Invalid videoId'.
  if (typeof body.videoId !== 'string' || !body.videoId.trim()) {
    return res.status(400).json({ error: 'videoId required' });
  }
  const videoId = body.videoId.trim();

  // Ingest only reads a file bunny already produced, so it is handled before
  // the limiter that guards the paid half.
  if (body.ingest === true) return ingest(res, auth, videoId);

  // Reading suggestions back is cheaper still: one GET, no write anywhere, so
  // it sits in front of the money limiter too.
  if (body.suggestions === true) return suggestions(res, videoId);

  // requireCapability already resolved the session; calling getSession again
  // would be a second round trip whose two answers could disagree.
  if (!(await allowCostly(callerId(req, auth.session, 'transcribe')))) {
    return res.status(429).json({ error: 'Too many transcription requests — try again later' });
  }

  // force=true re-runs transcription on a video that already has it — a
  // SECOND charge for the same minutes. Strict true only: a truthy value is
  // not good enough for something that bills.
  const force = body.force === true;
  if (body.sourceLanguage !== undefined && typeof body.sourceLanguage !== 'string') {
    return res.status(400).json({ error: 'sourceLanguage must be a string' });
  }
  const sourceLanguage = (body.sourceLanguage || '').trim();
  if (sourceLanguage && !LANG.test(sourceLanguage)) {
    return res.status(400).json({ error: 'Bad source language' });
  }

  // Chapter suggestions ride along with the same job — no extra per-minute
  // charge — but they are opt-in all the same: a video whose chapters an admin
  // has already typed has no use for a second opinion, and asking keeps "what
  // did this job produce" a question with an answer. Strict true, like force.
  const chapters = body.chapters === true;

  try {
    await transcribeVideo(videoId, {
      sourceLanguage: sourceLanguage || undefined,
      force,
      generateChapters: chapters,
    });
  } catch (e) {
    console.error('Could not queue transcription:', e);
    return res.status(502).json({ error: 'Could not queue transcription' });
  }

  await logAudit(
    auth.email,
    force ? 'video.retranscribe' : 'video.transcribe',
    chapters ? `${videoId} (with chapter suggestions)` : videoId
  );
  return res.json({ ok: true, queued: true, chapters });
}

// Reads bunny's generated chapters back as a proposal. READ-ONLY on purpose:
// this never touches the video-meta entry, so a transcription job can never
// replace a list an admin typed. The admin accepts by loading it into the
// textarea and saving through PUT /api/admin/videos — the same path a typed
// list takes. Not audit-logged, because nothing changed; the acceptance is
// what gets logged, exactly as if the lines had been typed.
async function suggestions(res, videoId) {
  let video;
  try {
    video = await getVideoById(videoId);
  } catch (e) {
    console.error('Could not read the video for chapter suggestions:', e);
    return res.status(502).json({ error: 'Could not read the video' });
  }
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const { chapters, ignored } = suggestedChapters(video);
  return res.json({ ok: true, chapters, ignored });
}

// Pulls the finished captions off bunny's CDN and stores the parsed cues.
// Separate from queueing because at queue time there is nothing to fetch.
async function ingest(res, auth, videoId) {
  let video;
  try {
    video = await getVideoById(videoId);
  } catch (e) {
    console.error('Could not read the video before ingesting captions:', e);
    return res.status(502).json({ error: 'Could not read the video' });
  }
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const languages = (video.captions || [])
    .map((caption) => String(caption?.srclang || '').trim())
    .filter((lang) => LANG.test(lang));

  // Not an error: transcription is probably still running.
  if (!languages.length) return res.json({ ok: true, ready: false, cues: 0 });

  // One track is enough for the panel. Prefer English when bunny produced
  // several, otherwise take the first — deterministic beats whatever order
  // the API happened to return.
  const language = languages.includes('en') ? 'en' : languages[0];

  let vtt;
  try {
    vtt = await fetchCaptionVtt(videoId, language);
  } catch (e) {
    console.error('Could not fetch a caption file:', e);
    return res.status(502).json({ error: 'Could not fetch the captions' });
  }

  const cues = parseVtt(vtt);
  // The file exists but parsed to nothing — report it rather than silently
  // storing an empty transcript that looks like "never transcribed".
  if (!cues.length) return res.json({ ok: true, ready: false, cues: 0, language });

  const result = await setTranscript(videoId, cues);
  if (!result.ok) return res.status(502).json({ error: result.error });

  await logAudit(auth.email, 'video.transcript_ingest', `${videoId} (${language}, ${cues.length})`);
  return res.json({ ok: true, ready: true, cues: cues.length, language });
}

export default withMonitorApi(handler);
