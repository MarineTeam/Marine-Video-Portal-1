// Whether the podcast feed is usable at all.
//
// PURE — safe to import anywhere. Kept separate from lib/bunny.js so the
// client-side Activity page can ask "should I show the podcast section?"
// without pulling the Bunny module in.
//
// The feed depends on direct CDN media URLs, which need BUNNY_CDN_HOSTNAME.
// Without it getVideoFileUrl returns '' and every item would be dropped for
// having no enclosure, leaving a valid-but-empty show — worse than no feed at
// all, because a subscriber sees a podcast that never has episodes. Same
// inert-until-configured posture as push (VAPID keys) and email (Resend key).
export function podcastFeedEnabled() {
  return Boolean((process.env.BUNNY_CDN_HOSTNAME || '').trim());
}
