// Transactional email via Resend (https://resend.com) — used to deliver private
// share links to their recipient, and to re-send an existing link on demand.
//
// The whole feature is INERT unless RESEND_API_KEY is set: mailEnabled() is false,
// sendShareEmail() no-ops and returns false, so a deployment without email
// configured behaves exactly as before (the admin just copies the link by hand).
// This mirrors the opt-in/inert posture of push (lib/push.js) and Sentry.
//
// We call Resend's REST API directly with fetch — no SDK dependency, and nothing
// is constructed at module load, so `next build` and CI (dummy env) are unaffected.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function mailEnabled() {
  return Boolean((process.env.RESEND_API_KEY || '').trim());
}

function fromAddress() {
  // Resend requires a verified sender. `onboarding@resend.dev` works out of the
  // box for the account owner while a custom domain is being verified.
  return (process.env.MAIL_FROM || '').trim() || 'Marine Video Portal <onboarding@resend.dev>';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the subject/html/text for a share-link email. The title is
// attacker-influenceable (it's the video title), so it's HTML-escaped before it
// goes anywhere near the markup body.
function shareEmail({ watchUrl, title, expiresInHours }) {
  const safeTitle = escapeHtml(title);
  const hrs = Number(expiresInHours) || 72;
  const subject = title ? `You've been sent "${title}"` : "You've been sent a private video";
  const heading = safeTitle || 'A private video has been shared with you';
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#070b14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e7eb;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:18px;margin:0 0 16px;">${heading}</h1>
      <p style="margin:0 0 20px;line-height:1.5;color:#cbd5e1;">
        Someone shared a private video with you on the Marine Video Portal.
        Open the link below and sign in with <strong>this email address</strong> to watch it.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${watchUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Watch the video</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">Or paste this link into your browser:</p>
      <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${watchUrl}" style="color:#60a5fa;">${watchUrl}</a></p>
      <p style="margin:0;font-size:12px;color:#64748b;">This link expires in about ${hrs} hours and only works for the email address it was sent to.</p>
    </div>
  </body>
</html>`;
  const text =
    `${title ? `You've been sent "${title}"` : "You've been sent a private video"}\n\n` +
    `Open this link and sign in with this email address to watch:\n${watchUrl}\n\n` +
    `This link expires in about ${hrs} hours and only works for the email address it was sent to.`;
  return { subject, html, text };
}

// Best-effort send: never throws, returns true only if Resend accepted the message.
// Callers should treat a false result as "email not delivered" (the link still
// exists and can be copied/resent), never as a fatal error.
export async function sendShareEmail({ to, watchUrl, title, expiresInHours }) {
  if (!mailEnabled() || !to || !watchUrl) return false;
  const { subject, html, text } = shareEmail({ watchUrl, title, expiresInHours });
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}
