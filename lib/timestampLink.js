// Links that start a video at a moment: /watch/video/<id>?t=124
//
// PURE MODULE — no Redis, no fetch. The watch page parses the parameter
// server-side and the player renders the copy button, so both import this and
// agree on what a timestamp means.
//
// WHY. Chapters and the transcript already seek within a video, but neither
// could be SHARED: "listen from 24:15" meant telling someone to scrub. This
// makes the address bar carry the moment.
//
// WHAT IT ACCEPTS, and why more than one shape. The link this app generates is
// always plain seconds, but people hand-edit these and paste them from
// elsewhere, so `1:30`, `1h2m3s` and `90s` are read too. Being liberal costs a
// few lines here and saves a viewer landing at 0:00 wondering why the link
// they were sent did not work.

// A day. Long enough for any recording this portal will ever hold, short
// enough that a junk value cannot become a seek request for the year 3000.
export const MAX_SECONDS = 24 * 60 * 60;

const CLOCK = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/;
const UNITS = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

function clamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds);
  return whole > MAX_SECONDS ? MAX_SECONDS : whole;
}

// Returns whole seconds, or null when the value is not a timestamp we accept.
// NULL rather than 0: "unparseable" and "start at the beginning" are different
// answers, and only one of them should override a saved resume position.
export function parseTimeParam(value) {
  // An array means the parameter was repeated (?t=1&t=2). Which one did they
  // mean? Neither — refuse rather than pick.
  if (Array.isArray(value)) return null;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;

  if (/^\d+$/.test(text)) return clamp(Number(text));

  const clock = CLOCK.exec(text);
  if (clock) {
    const [, h, m, s] = clock;
    const minutes = Number(m);
    const seconds = Number(s);
    // 90:00 is a legitimate way to write an hour and a half, but 1:90:00 is a
    // typo — minutes only run past 59 when there is no hours field.
    if (seconds > 59) return null;
    if (h !== undefined && minutes > 59) return null;
    return clamp((h ? Number(h) : 0) * 3600 + minutes * 60 + seconds);
  }

  const units = UNITS.exec(text);
  // The regex matches the empty string and any of the three parts alone, so
  // require at least one to have been present.
  if (units && (units[1] || units[2] || units[3])) {
    const [, h, m, s] = units;
    return clamp(Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0));
  }

  return null;
}

// What this app puts in a link it generates: plain seconds, the shape every
// consumer of parseTimeParam reads first and nothing can mis-parse.
export function formatTimeParam(seconds) {
  const whole = clamp(Number(seconds));
  return whole === null ? '' : String(whole);
}

// The shareable address for a moment. Takes the page's own URL so it works
// from any watch route without this module knowing their shapes, and strips
// any t already there rather than appending a second one.
export function linkAtTime(href, seconds) {
  const base = String(href || '').split('#')[0];
  const [path, search = ''] = base.split('?');
  const params = new URLSearchParams(search);
  const value = formatTimeParam(seconds);
  if (value) params.set('t', value);
  else params.delete('t');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
