
# Private Video Portal

A private video site built with **Next.js**, hosted on **Vercel**, using **bunny.net Stream** for video storage/playback and **Auth0** for login. Access is restricted to approved viewers only, and admins can generate one-off private links for anyone else.

## How it works

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed by an admin) see the video list on the homepage. Everyone else sees a "not approved" message after logging in.
- The homepage shows a list of video titles (most recent first), capped at a number the admin controls, paginated 10 per page. Clicking a title opens a dedicated watch page where the video actually plays.
- Videos are never public. Every play uses a **signed, time-limited bunny.net token** generated fresh on each request — nothing is ever a permanent public URL.
- Admins can also generate a **private one-time share link** (`/watch/{shareId}`) for a specific video and a specific recipient email. That link forces an Auth0 login, and only plays if the logged-in email matches the one the admin specified. It expires automatically after a set number of hours.
- `/admin` is restricted to a fixed list of admin emails (`ADMIN_EMAILS`), and lets you:
  - Set how many videos show on the homepage
  - Add/remove approved viewer emails
  - Create private share links per video

## Project structure

```
pages/
  _app.js                    Auth0 session provider wrapper
  index.js                   Homepage — paginated video list (approved viewers only)
  admin.js                   Admin panel — settings, viewer list, share links
  api/
    auth/[auth0].js          Auth0 login/logout/callback routes
    videos.js                 Returns a page of video titles for approved viewers
    admin/
      videos.js               Full video list, admin only
      viewers.js               Add/remove/list approved viewer emails
      settings.js               Get/set homepage video count
      share.js                   Create a private share record
  watch/
    video/[id].js             Plays a video for an approved viewer (clicked from homepage)
    [shareId].js               Plays a video via a private share link (forced login + email match)
lib/
  bunny.js                    bunny.net API calls + signed embed URL generation
  redis.js                    Connection to the Upstash/Vercel KV database
```

## Environment variables (set in Vercel → Settings → Environment Variables)

| Key | Description |
|---|---|
| `AUTH0_SECRET` | Random 32-byte hex string used to encrypt the session cookie. Generate at generate-secret.vercel.app/32. |
| `AUTH0_BASE_URL` | Your site's exact URL, e.g. `https://private-video-portal.vercel.app` (no trailing slash). |
| `AUTH0_ISSUER_BASE_URL` | Your Auth0 domain with `https://`, e.g. `https://your-tenant.us.auth0.com` (no trailing slash). |
| `AUTH0_CLIENT_ID` | From your Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From your Auth0 application settings. |
| `BUNNY_LIBRARY_ID` | Your bunny.net Stream library ID. |
| `BUNNY_API_KEY` | Your bunny.net Stream library API key. |
| `BUNNY_TOKEN_AUTH_KEY` | Your bunny.net library's Token Authentication key (Security tab). |
| `ADMIN_EMAILS` | Comma-separated list of admin emails, e.g. `you@example.com,other@example.com`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when you connect a Redis/Upstash database via Vercel's Storage tab. Used for the approved-viewer list, homepage video count, and share-link records. |

After adding or changing any of these, redeploy — env var changes only apply to new deployments.

## One-time setup checklist

1. **bunny.net**: create a Stream library, enable Token Authentication, upload videos.
2. **Auth0**: create a Regular Web Application. Set Allowed Callback URLs / Logout URLs / Web Origins to your exact Vercel domain. If you want to prevent random public sign-ups, go to Authentication → Database → your connection and enable "Disable Sign Ups," then add approved people manually under User Management → Users.
3. **Vercel**: import the GitHub repo, connect a Redis/Upstash database under Storage, add all environment variables above, deploy.
4. Log in with an `ADMIN_EMAILS` account, go to `/admin`, set the homepage video count, and add approved viewer emails.

## Common issues

- **`npm install` fails on deploy** — usually a version mismatch between `next` and `@auth0/nextjs-auth0`'s peer dependency requirement, or a stray `package-lock.json`/`yarn.lock` committed alongside `package.json`. Check the build log for the exact `ERESOLVE` message.
- **"issuerBaseURL must be a valid uri"** — `AUTH0_ISSUER_BASE_URL` is missing `https://`, has a trailing slash, or has stray whitespace.
- **"Missing state cookie" on callback** — you started the login from a different domain/URL than the one set in `AUTH0_BASE_URL` (e.g. an old preview deployment link). Always start from your exact production URL.
- **Logout doesn't redirect back** — check Auth0's **Allowed Logout URLs** field specifically; it's separate from Allowed Callback URLs and easy to forget.
- **Homepage shows more videos than expected** — bunny.net's `itemsPerPage` isn't always treated as a hard cap, so the app trims the result with `.slice()` after fetching as a safeguard. If this regresses, check that `pages/api/videos.js` still slices after calling `listVideos()`.

## Notes on the private share links

Share links match by **exact email address**. If a recipient logs into Auth0 with a different email than the one the admin typed when creating the link (e.g. they have multiple accounts), they'll be blocked even though they're the intended person — confirm which email they use before sharing.
