# Features

What the Marine Video Portal does, grouped by the person using it.

## For viewers

- **Sign-in gate.** The portal is private. Visitors must sign in with Auth0; only
  approved emails (and admins) can reach the library. A signed-in but unapproved user
  is told plainly that they aren't on the list yet.
- **Video grid.** Approved videos appear as a thumbnail grid, falling back to a clean
  title list when thumbnails aren't available.
- **Search.** Filter the whole library by title as you type.
- **Collections.** Videos can be grouped into collections; viewers filter by them with
  a row of chips.
- **Continue watching.** Playback position is remembered, so partly-watched videos
  surface at the top with a progress bar and resume where you left off.
- **Secure playback.** Videos play through short-lived, signed Bunny embeds — no raw,
  shareable video URLs.
- **Share links.** A viewer can be handed a link to a single video that only works
  when signed in as the email it was issued to, and that expires on a set schedule.
- **Installable app (PWA).** The portal can be installed to a home screen and ships a
  web app manifest, icons, and a service worker.
- **Push notifications** (optional). Viewers who opt in get a push alert when a new
  video is published.

## For admins

Admins are defined by `ADMIN_EMAILS`. The admin panel (`/admin`) is gated on the
server, so a non-admin never receives the admin UI at all.

### Video management

- **Direct-to-Bunny uploads.** Drag-and-drop or pick a file; the browser uploads it
  straight to bunny.net over a resumable TUS session using a server-signed ticket. The
  Bunny API key never reaches the client.
- **Rename and delete** videos in place.
- **Custom ordering.** Drag videos to set the exact order viewers see. Newly uploaded
  videos surface on top until placed.
- **Homepage cap.** Choose how many videos the default (unfiltered) home view shows.
- **Collections.** Create and delete collections and assign videos to them.

### Access control

- **Approved-viewer list.** Add or remove viewer emails one at a time or in bulk.
- **Share links.** Generate an email-bound, expiring link (default 72h, capped at 30
  days) for any single video, and see which links are active and whether they've been
  viewed.
- **Viewer activity.** A "last seen" timestamp per approved viewer.

### Insight & operations

- **Analytics.** Library statistics pulled from Bunny (views, watch time, and related
  metrics).
- **Audit log.** The last 200 admin actions (shares created, and similar) are recorded
  and viewable.
- **Broadcast push.** Send a custom push notification to all approved viewers and
  admins at once.
- **Theme customization.** Pick an accent color scheme from presets (Ocean, Sunset,
  Forest, Grape, Rose, Amber, Slate) or set custom hex accents; the choice is applied
  site-wide through CSS variables.

## Under the hood

- **Rate limiting.** A per-route, per-caller sliding-window limiter (Upstash) guards
  the API and fails open, so an infrastructure hiccup never locks real users out.
- **Signed URLs everywhere.** TUS uploads, video embeds, and (optionally) thumbnails
  are all signed server-side.
- **Input validation.** Bunny video/collection IDs are validated as UUIDs before being
  placed into outbound request URLs.
- **Idle timeout.** Inactive sessions are handled client-side to reduce the window for
  an unattended, signed-in tab.
- **Inert-by-default integrations.** Web Push and Sentry stay completely dormant unless
  their environment variables are provided — a deployment without them behaves as if
  the feature doesn't exist.
- **Error monitoring** (optional). Sentry captures runtime errors when a DSN is set.
