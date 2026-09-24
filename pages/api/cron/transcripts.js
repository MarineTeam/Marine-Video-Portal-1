import { logAudit } from '../../../lib/audit';
import { cronSecret, isCronAuthorized } from '../../../lib/cronAuth';
import { withMonitorApi } from '../../../lib/monitor';
import { MAX_COLLECT_PER_SCHEDULED_RUN } from '../../../lib/transcribeQueue';
import { collectFinishedTranscripts } from '../../../lib/transcriptCollect';

// Scheduled job: collect transcriptions bunny has finished.
//
// The admin video list already collects them, but only when an admin opens the
// Videos tab — so a transcript queued on Sunday could sit uncollected until
// someone looked on Wednesday, with the watch page showing none. This runs the
// same collector on a schedule (vercel.json "crons"), with a larger per-run
// cap because no admin is waiting on it.
//
// NOT a viewer or admin route. There is no session here and none is wanted:
// the caller is Vercel's cron runner, proven by CRON_SECRET (lib/cronAuth.js).
// Without that secret the route answers 404 — inert until configured. This
// repo has no middleware, so nothing else stands in front of it; the secret is
// its whole gate (architecture contract, Decision 18).
//
// Safe to run twice at once or twice in a row: the collector takes a lock, and
// a transcript that is already collected is no longer pending.

// Room for a full run (lib/transcribeQueue.js caps the videos per run).
export const config = { maxDuration: 60 };

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = cronSecret();
  if (!secret) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isCronAuthorized(req.headers?.authorization, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { collected, expired, busy } = await collectFinishedTranscripts({
      limit: MAX_COLLECT_PER_SCHEDULED_RUN,
    });
    for (const item of collected) {
      await logAudit(
        'scheduled job',
        'video.transcript_ingest',
        `${item.videoId} (${item.language}, ${item.cues}, collected on schedule)`
      );
    }
    // Counts only: this answer goes to the cron log, and the video ids are
    // already in the audit log for anyone entitled to see them.
    return res.json({ ok: true, collected: collected.length, expired: expired.length, busy });
  } catch (e) {
    console.error('Scheduled transcript collection failed:', e);
    return res.status(500).json({ error: 'Collection failed' });
  }
}

export default withMonitorApi(handler);
