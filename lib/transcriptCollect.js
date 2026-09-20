// Collects transcriptions bunny has finished, for videos an admin queued and
// has not fetched by hand.
//
// SERVER ONLY — this talks to bunny and Redis. Which queued jobs to look at is
// decided by lib/transcribeQueue.js, which is pure; this module only does what
// that one decided.
//
// It runs on the admin video list, the same place the new-video announcement
// already rides, and is best-effort end to end: an admin loading their own
// video list must never see an error because a transcript could not be
// collected. Whatever fails is tried again next time, until the job ages out.
import { fetchCaptionVtt, getVideoById } from './bunny';
import { parseVtt } from './captions';
import {
  clearTranscribePending,
  getTranscribePending,
  setTranscript,
} from './captionsStore';
import { planCollection } from './transcribeQueue';

const LANG = /^[A-Za-z0-9-]{2,12}$/;

async function collectOne(videoId) {
  const video = await getVideoById(videoId);
  // getVideoById answers null for a deleted video rather than throwing, so
  // that case has to be read — it is also the likeliest reason a marker never
  // resolves, and it ages out on its own.
  if (!video) return null;

  const languages = (video.captions || [])
    .map((caption) => String(caption?.srclang || '').trim())
    .filter((lang) => LANG.test(lang));
  if (!languages.length) return null;

  // The same deterministic choice the manual ingest makes: English when bunny
  // produced several, otherwise the first. Collecting a different track than
  // the button would have is a surprise nobody needs.
  const language = languages.includes('en') ? 'en' : languages[0];
  const cues = parseVtt(await fetchCaptionVtt(videoId, language));
  if (!cues.length) return null;

  const result = await setTranscript(videoId, cues);
  // This store reports failure rather than throwing, so the result has to be
  // read: treating a failed write as collected would clear the marker and
  // lose a transcript that was already paid for.
  if (!result?.ok) return null;
  return { language, cues: cues.length };
}

export async function collectFinishedTranscripts() {
  const pending = await getTranscribePending();
  if (!Object.keys(pending).length) return { collected: [], expired: [] };

  const { collect, expired } = planCollection(pending);
  // Dropped without another attempt: a job this old is not going to finish,
  // and retrying it costs two bunny calls on every admin page load forever.
  if (expired.length) await clearTranscribePending(expired);

  const collected = [];
  for (const videoId of collect) {
    try {
      const result = await collectOne(videoId);
      if (!result) continue; // still running — leave the marker for next time
      await clearTranscribePending(videoId);
      collected.push({ videoId, ...result });
    } catch (e) {
      // Left pending on purpose: a transient bunny failure should be retried,
      // and a permanent one ages out on its own.
      console.error(`Could not collect the transcript for ${videoId}:`, e);
    }
  }
  return { collected, expired };
}
