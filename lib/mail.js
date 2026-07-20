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

// Build the subject/html/text for a share-links email. `items` is one or more
// { title, watchUrl } pairs — a bulk share sends ONE email per recipient
// listing only the links meant for them, never anyone else's. Titles are
// attacker-influenceable (they're video titles), so they're HTML-escaped
// before they go anywhere near the markup body.
function shareLinksEmail({ items, expiresInHours }) {
  const hrs = Number(expiresInHours) || 72;
  const single = items.length === 1;
  const subject = single
    ? (items[0].title ? `You've been sent "${items[0].title}"` : "You've been sent a private video")
    : `You've been sent ${items.length} private videos`;
  const heading = single
    ? (escapeHtml(items[0].title) || 'A private video has been shared with you')
    : `${items.length} private videos have been shared with you`;

  const rows = items
    .map(
      ({ title, watchUrl }) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #1f2937;">
          <a href="${watchUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">
            ${escapeHtml(title) || 'Watch video'}
          </a>
          <div style="margin-top:8px;font-size:12.5px;word-break:break-all;"><a href="${watchUrl}" style="color:#60a5fa;">${watchUrl}</a></div>
        </td>
      </tr>`
    )
    .join('');

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#070b14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e7eb;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:18px;margin:0 0 16px;">${heading}</h1>
      <p style="margin:0 0 20px;line-height:1.5;color:#cbd5e1;">
        ${single ? 'Someone shared a private video with you' : 'Someone shared these private videos with you'} on the Marine Video Portal.
        Open a link below and sign in with <strong>this email address</strong> to watch.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">${rows}</table>
      <p style="margin:0;font-size:12px;color:#64748b;">${single ? 'This link expires' : 'These links expire'} in about ${hrs} hours and ${single ? 'only works' : 'only work'} for the email address ${single ? 'it was' : 'they were'} sent to.</p>
    </div>
  </body>
</html>`;

  const text =
    `${single ? (items[0].title ? `You've been sent "${items[0].title}"` : "You've been sent a private video") : `You've been sent ${items.length} private videos`}\n\n` +
    `Open a link below and sign in with this email address to watch:\n\n` +
    items.map(({ title, watchUrl }) => `${title || 'Watch video'}: ${watchUrl}`).join('\n') +
    `\n\n${single ? 'This link expires' : 'These links expire'} in about ${hrs} hours and ${single ? 'only works' : 'only work'} for the email address ${single ? 'it was' : 'they were'} sent to.`;

  return { subject, html, text };
}

// Best-effort send: never throws, returns true only if Resend accepted the message.
// Callers should treat a false result as "email not delivered" (the link still
// exists and can be copied/resent), never as a fatal error.
// `items` is an array of { title, watchUrl } — all destined for the single `to` recipient.
export async function sendShareLinksEmail({ to, items, expiresInHours }) {
  if (!mailEnabled() || !to || !Array.isArray(items) || items.length === 0) return false;
  const { subject, html, text } = shareLinksEmail({ items, expiresInHours });
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

// Convenience wrapper for the single video / single recipient case.
export async function sendShareEmail({ to, watchUrl, title, expiresInHours }) {
  return sendShareLinksEmail({ to, items: [{ title, watchUrl }], expiresInHours });
}
