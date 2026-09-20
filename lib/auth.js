export function isAdmin(email) {
  if (!email) return false;

  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return admins.includes(email.toLowerCase());
}

export const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical limit

// Whether a string is plausibly an email address.
//
// Plain string ops instead of a single regex: the previous
// /^[^\s@]+@[^\s@]+\.[^\s@]+$/ didn't exclude '.' from its char classes, so
// the boundary before the literal '.' was ambiguous — a crafted string in a
// bulk-paste input could cause polynomial-time backtracking. This is linear.
//
// It lives here rather than in a route because two bulk-paste surfaces now
// need it — /api/admin/viewers (approving people) and lib/groups.js (putting
// them in a group). Two copies of a ReDoS fix is one copy waiting to be
// reverted by someone who finds the regex tidier.
export function isLikelyEmail(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}
