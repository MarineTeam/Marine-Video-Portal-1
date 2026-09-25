import { emailsHoldingCapability } from './roles';
import { mailEnabled, sendAccessRequestEmail } from './mail';
import { pushEnabled, sendToEmails } from './push';
import { getSiteName } from './brandingStore';

// Tells the people who can action an access request that one has arrived.
// Without this, a pending request sits on the Access tab until somebody
// happens to look — which, for a portal an admin visits once a month, can be
// weeks.
//
// BEST-EFFORT, ALWAYS. Every failure path here is swallowed: a request being
// recorded is the product, and a notification failing must never turn a
// viewer's "please let me in" into an error page. Same posture as
// lib/audit.js's logAudit and lib/push.js's maybeAnnounceReady.
//
// Inert until configured, like every other optional feature here: no
// RESEND_API_KEY means no email, no VAPID keys means no push, and with neither
// this does nothing at all and says nothing about it.

// Who gets told: everyone who holds 'viewers:manage', which is exactly the
// capability needed to approve the request — owners plus anyone whose roles
// give it. Nobody else: telling someone who cannot act on it is noise.
async function recipients() {
  return (await emailsHoldingCapability('viewers:manage')).filter(Boolean);
}

export async function notifyNewAccessRequest(record) {
  if (!record || !record.email) return { emailed: 0, pushed: 0 };
  if (!mailEnabled() && !pushEnabled()) return { emailed: 0, pushed: 0 };

  let emailed = 0;
  let pushed = 0;

  try {
    const to = await recipients();
    if (!to.length) return { emailed: 0, pushed: 0 };

    const baseUrl = (process.env.AUTH0_BASE_URL || '').replace(/\/+$/, '');
    const adminUrl = `${baseUrl}/admin`;

    if (mailEnabled()) {
      for (const address of to) {
        try {
          const ok = await sendAccessRequestEmail({
            to: address,
            requesterEmail: record.email,
            note: record.note,
            adminUrl,
          });
          if (ok) emailed += 1;
        } catch {
          // one bad address must not stop the rest
        }
      }
    }

    if (pushEnabled()) {
      try {
        const siteName = await getSiteName();
        const result = await sendToEmails(to, {
          title: `Access request — ${siteName}`,
          body: `${record.email} is asking for access`,
          url: '/admin',
        });
        pushed = result?.sent || 0;
      } catch {
        // push is the softer of the two channels; email may still have landed
      }
    }
  } catch {
    // resolving recipients failed (Redis blip) — nothing to do but stay quiet
  }

  return { emailed, pushed };
}
