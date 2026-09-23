// Links that open the library already searched — the watch page's passage
// links use them (/?q=Philippians%202).
//
// PURE — imports nothing; both the watch page and the homepage render with it.

// The longest search a link may carry into the homepage. A passage is a few
// dozen characters; this only stops a crafted URL filling the search box.
// Also /api/videos's own limit on a search, so the box never holds more than
// the server would read.
export const MAX_LINKED_QUERY = 100;

// What a ?q= in the homepage URL searches for, or '' for nothing. Strings
// only: Next hands a repeated parameter over as an array, and joining one
// would search for text nobody typed. The box ends up holding exactly this,
// and the search it runs is the ordinary one — through /api/videos's group,
// schedule and verification gates — so a link can pre-fill a search but never widen one.
export function linkedQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_LINKED_QUERY).trim();
}

export function passageSearchHref(label) {
  return `/?q=${encodeURIComponent(String(label || ''))}`;
}
