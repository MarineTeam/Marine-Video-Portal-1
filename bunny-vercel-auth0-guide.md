# Private Video Site: Vercel + bunny.net + Auth0 (Browser-Only Build)

No desktop apps, no local installs, no terminal. You'll use:
- **bunny.net dashboard** — video hosting
- **Auth0 dashboard** — login
- **github.com** (web editor) — write the code
- **vercel.com dashboard** — hosting, deployment, and a small database (this is what runs `npm install` for you)

## Architecture

- Anyone visiting your site must log in via Auth0
- After login, the homepage shows the **latest 2 videos**
- Your email(s) are flagged as **admin** → `/admin` lists every video in your bunny.net library
- For each video, the admin types a **recipient's email** and gets back a private link like `/watch/{shareId}`
- That link **forces the recipient to log in via Auth0**, and only plays the video if their logged-in email matches the one the admin specified. The video itself is always served through a short-lived signed bunny.net token, generated fresh on each view — never a permanent public URL.

---

## Phase 1 — bunny.net setup

1. Log into bunny.net → **Stream** → create a **Video Library** (if you don't have one).
2. Upload your videos (drag-and-drop in the dashboard works fine).
3. Open the library → **Security** tab → enable **Token Authentication**. Copy the **Authentication Key** → this is `BUNNY_TOKEN_AUTH_KEY`.
4. Still in library settings, find:
   - **Library ID** → `BUNNY_LIBRARY_ID`
   - **API Key** (library-level API key) → `BUNNY_API_KEY`

Keep these three values — you'll paste them into Vercel later.

---

## Phase 2 — Auth0 setup

1. Auth0 dashboard → **Applications** → **Create Application** → "Regular Web Application."
2. Note the **Domain**, **Client ID**, **Client Secret** (Settings tab). Leave Callback/Logout URLs blank for now — you'll fill them in once you know your Vercel URL.
3. Visit **generate-secret.vercel.app/32** in your browser to generate a random hex string → this becomes `AUTH0_SECRET` (encrypts the login cookie; unrelated to bunny.net).

---

## Phase 3 — Create the GitHub repo

1. **github.com/new** → create a repo, e.g. `private-video-site`.
2. Add files either by clicking **Add file → Create new file** and typing the full path (GitHub auto-creates folders), or by pressing **`.`** on the repo page to open **github.dev** — a full browser-based VS Code, nothing installed.

Create the following files exactly as shown.

### `package.json`
```json
{
  "name": "private-video-site",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "@auth0/nextjs-auth0": "^3.5.0",
    "@upstash/redis": "^1.34.0"
  }
}
```

### `next.config.js`
```js
/** @type {import('next').NextConfig} */
const nextConfig = {};
module.exports = nextConfig;
```

### `pages/_app.js`
```jsx
import { UserProvider } from '@auth0/nextjs-auth0/client';

export default function App({ Component, pageProps }) {
  return (
    <UserProvider>
      <Component {...pageProps} />
    </UserProvider>
  );
}
```

### `pages/api/auth/[auth0].js`
```js
import { handleAuth } from '@auth0/nextjs-auth0';

export default handleAuth();
```

### `lib/bunny.js`
```js
import crypto from 'crypto';

const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';

export async function listVideos({ itemsPerPage = 100 } = {}) {
  const res = await fetch(
    `${BUNNY_API_BASE}/${process.env.BUNNY_LIBRARY_ID}/videos?page=1&itemsPerPage=${itemsPerPage}&orderBy=date`,
    { headers: { AccessKey: process.env.BUNNY_API_KEY } }
  );
  if (!res.ok) throw new Error(`Bunny API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

export function signVideoToken(videoId, expiresInSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const hashable = `${process.env.BUNNY_TOKEN_AUTH_KEY}${videoId}${expires}`;
  const token = crypto.createHash('sha256').update(hashable).digest('hex');
  return { token, expires };
}

export function getEmbedUrl(videoId, expiresInSeconds = 3600) {
  const { token, expires } = signVideoToken(videoId, expiresInSeconds);
  return `https://iframe.mediadelivery.net/embed/${process.env.BUNNY_LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}`;
}
```

### `lib/redis.js`
```js
import { Redis } from '@upstash/redis';

// Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN once you connect a
// Storage database to this project. If the dashboard shows different
// names (e.g. UPSTASH_REDIS_REST_URL), use those instead.
export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
```

### `pages/api/videos.js` (homepage — any logged-in user, latest 2)
```js
import { getSession } from '@auth0/nextjs-auth0';
import { listVideos, getEmbedUrl } from '../../lib/bunny';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const limit = parseInt(req.query.limit) || 2;
  const videos = await listVideos({ itemsPerPage: limit });

  const result = videos.map((v) => ({
    id: v.guid,
    title: v.title,
    embedUrl: getEmbedUrl(v.guid, 3600), // valid 1 hour
  }));

  res.json(result);
}
```

### `pages/api/admin/videos.js` (admin only — lists everything)
```js
import { getSession } from '@auth0/nextjs-auth0';
import { listVideos } from '../../../lib/bunny';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });

  const videos = await listVideos({ itemsPerPage: 100 });
  res.json(videos.map((v) => ({ id: v.guid, title: v.title, dateUploaded: v.dateUploaded })));
}
```

### `pages/api/admin/share.js` (admin only — creates a share record)
```js
import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../../lib/redis';
import crypto from 'crypto';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).end();

  const { videoId, title, email, expiresInHours = 72 } = req.body || {};
  if (!videoId || !email) return res.status(400).json({ error: 'videoId and email are required' });

  const shareId = crypto.randomUUID();
  const ttlSeconds = Math.min(expiresInHours, 720) * 3600; // capped at 30 days

  await redis.set(
    `share:${shareId}`,
    { videoId, title, email: email.toLowerCase().trim() },
    { ex: ttlSeconds }
  );

  const watchUrl = `${process.env.AUTH0_BASE_URL}/watch/${shareId}`;
  res.json({ watchUrl, expiresInHours });
}
```

### `pages/watch/[shareId].js` (the forced-login private viewing page)
```jsx
import { getSession } from '@auth0/nextjs-auth0';
import { redis } from '../../lib/redis';
import { getEmbedUrl } from '../../lib/bunny';

export async function getServerSideProps({ req, res, params }) {
  const session = await getSession(req, res);

  if (!session) {
    return {
      redirect: {
        destination: `/api/auth/login?returnTo=/watch/${params.shareId}`,
        permanent: false,
      },
    };
  }

  const share = await redis.get(`share:${params.shareId}`);

  if (!share) {
    return { props: { error: 'This link has expired or does not exist.' } };
  }

  if (share.email !== session.user.email.toLowerCase()) {
    return {
      props: {
        error: `This link was shared with ${share.email}. You're logged in as ${session.user.email}.`,
      },
    };
  }

  return {
    props: {
      embedUrl: getEmbedUrl(share.videoId, 3600),
      title: share.title || '',
    },
  };
}

export default function Watch({ embedUrl, title, error }) {
  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <p>{error}</p>
        <a href="/api/auth/logout?returnTo=/">Log out and try a different account</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>{title}</h1>
      <iframe
        src={embedUrl}
        width="640"
        height="360"
        allow="autoplay; fullscreen"
        frameBorder="0"
        title={title}
      />
    </div>
  );
}
```

### `pages/admin.js`
```jsx
import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return;
    fetch('/api/admin/videos')
      .then((r) => {
        if (!r.ok) throw new Error('Forbidden — this account is not an admin');
        return r.json();
      })
      .then(setVideos)
      .catch((e) => setError(e.message));
  }, [user]);

  async function handleShare(video) {
    const email = (emails[video.id] || '').trim();
    if (!email) return alert('Enter the recipient\'s email first');

    const res = await fetch('/api/admin/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: video.id, title: video.title, email, expiresInHours: 72 }),
    });
    const data = await res.json();
    setShareLinks((prev) => ({ ...prev, [video.id]: data.watchUrl }));
  }

  if (isLoading) return <p>Loading...</p>;
  if (!user) return <a href="/api/auth/login">Log in</a>;
  if (error) return <p>{error}</p>;

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Admin — Video Library</h1>
      <a href="/api/auth/logout">Log out</a>
      <ul>
        {videos.map((v) => (
          <li key={v.id} style={{ marginBottom: 20 }}>
            <strong>{v.title}</strong>
            <br />
            <input
              type="email"
              placeholder="recipient@example.com"
              value={emails[v.id] || ''}
              onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
              style={{ width: 240, marginRight: 8 }}
            />
            <button onClick={() => handleShare(v)}>Create private link (72h)</button>
            {shareLinks[v.id] && (
              <div style={{ marginTop: 4 }}>
                <input style={{ width: 420 }} readOnly value={shareLinks[v.id]} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### `pages/index.js`
```jsx
import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect, useState } from 'react';

export default function Home() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);

  useEffect(() => {
    if (!user) return;
    fetch('/api/videos?limit=2')
      .then((r) => r.json())
      .then(setVideos);
  }, [user]);

  if (isLoading) return <p>Loading...</p>;

  if (!user) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Welcome</h1>
        <a href="/api/auth/login">Log in</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Hi, {user.name}</h1>
      <a href="/admin">Admin panel</a> | <a href="/api/auth/logout">Log out</a>
      <h2>Latest videos</h2>
      <div style={{ display: 'flex', gap: 16 }}>
        {videos.map((v) => (
          <div key={v.id}>
            <iframe
              src={v.embedUrl}
              width="320"
              height="180"
              allow="autoplay; fullscreen"
              frameBorder="0"
              title={v.title}
            />
            <p>{v.title}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Commit/push all of these (GitHub web UI commits on save; in github.dev, use the Source Control icon → Commit → Sync).

---

## Phase 4 — Import into Vercel

1. **vercel.com** → log in with "Continue with GitHub" → **Add New → Project** → import `private-video-site` → **Deploy**. It's expected to error or run incompletely — no env vars yet.
2. Copy the URL Vercel gives you, e.g. `https://private-video-site-yourname.vercel.app`.

---

## Phase 5 — Add a database for share links (Vercel Storage)

1. In your Vercel project → **Storage** tab → **Create Database**.
2. Pick the Redis / KV option (currently provided via the Marketplace, powered by Upstash — labeled something like "Upstash for Redis" or "KV").
3. Create it, then **Connect** it to your `private-video-site` project. Vercel automatically injects the connection env vars — note what they're named (usually `KV_REST_API_URL` and `KV_REST_API_TOKEN`); the code above expects those exact names. If yours differ, just edit `lib/redis.js` to match.

---

## Phase 6 — Wire up Auth0 with your real URL

In Auth0 → your application → **Settings**, fill in (using your real Vercel URL):

- **Allowed Callback URLs:** `https://private-video-site-yourname.vercel.app/api/auth/callback`
- **Allowed Logout URLs:** `https://private-video-site-yourname.vercel.app`
- **Allowed Web Origins:** `https://private-video-site-yourname.vercel.app`

Save.

---

## Phase 7 — Add environment variables in Vercel

Project → **Settings → Environment Variables**:

| Key | Value |
|---|---|
| `AUTH0_SECRET` | the hex string from generate-secret.vercel.app |
| `AUTH0_BASE_URL` | `https://private-video-site-yourname.vercel.app` |
| `AUTH0_ISSUER_BASE_URL` | `https://YOUR-TENANT.auth0.com` |
| `AUTH0_CLIENT_ID` | from Auth0 app settings |
| `AUTH0_CLIENT_SECRET` | from Auth0 app settings |
| `BUNNY_LIBRARY_ID` | from bunny.net |
| `BUNNY_API_KEY` | bunny.net library API key |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library Authentication Key |
| `ADMIN_EMAILS` | your email(s), comma-separated |

(`KV_REST_API_URL` / `KV_REST_API_TOKEN` should already be there from Phase 5.)

Then **Deployments → ⋯ → Redeploy** so the new vars take effect.

---

## Phase 8 — Test it

1. Visit your site → log in with an `ADMIN_EMAILS` account → homepage shows the **2 latest** videos playing via signed links.
2. Go to **Admin panel** → see every video → type a recipient's email → **Create private link** → copy the `/watch/...` URL it gives you and send it to them however you like.
3. Recipient opens the link → Auth0 prompts them to log in → if they log in with the **exact email** the admin entered, the video plays. If they use a different account, they see a clear mismatch message instead of the video. After the expiry window, the link simply stops working.

---

## Notes

- Share links currently match by exact email — if your recipient signs up with Auth0 using a different email than the one you typed, they'll be blocked. You'll just need to ask them which email they use, or re-share with the correct address.
- Non-admin logged-in users never see `/admin` data — the API returns 403 and the page shows the error rather than any video info.
- If the build fails on Vercel, double check `package.json` for typos first — it's the one hand-typed file most likely to break the install step.
