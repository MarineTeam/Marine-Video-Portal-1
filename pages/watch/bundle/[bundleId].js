import { getSession } from '@auth0/nextjs-auth0';
import { getBundle, getShare, isExpired } from '../../../lib/shareBundle';
import AppShell from '../../../components/AppShell';
import { IconChevronLeft } from '../../../components/icons';

// A bundle is a pure grouping list — just shareIds, an email, and its own
// expiry. Everything shown here (title, view/playback status, live expiry)
// is re-read from each member's own share record on every load, so revoking
// or extending one item is reflected instantly without ever touching this
// bundle record.
export async function getServerSideProps({ req, res, params }) {
  const session = await getSession(req, res);

  if (!session) {
    return {
      redirect: {
        destination: `/api/auth/login?returnTo=/watch/bundle/${params.bundleId}`,
        permanent: false,
      },
    };
  }

  const bundle = await getBundle(params.bundleId);
  if (!bundle) {
    return { props: { error: 'This page has expired or does not exist.' } };
  }

  if (bundle.email !== session.user.email.toLowerCase()) {
    return {
      props: {
        error: "This page isn't valid for your account. If you believe this is a mistake, contact the person who shared it with you.",
      },
    };
  }

  const items = [];
  for (const shareId of bundle.itemIds) {
    const share = await getShare(shareId);
    if (!share || isExpired(share) || share.revoked) continue; // revoked or lapsed — drop silently, bundle record untouched
    items.push({
      shareId,
      title: share.title || 'Untitled',
      expiresAt: share.expiresAt,
      views: share.views || 0,
      lastViewedAt: share.lastViewedAt || null,
      completed: Boolean(share.completed),
      furthestPct: share.furthestPct || 0,
    });
  }
  items.sort((a, b) => a.expiresAt - b.expiresAt);

  return { props: { items } };
}

export default function Bundle({ items, error }) {
  return (
    <AppShell>
      <div className="watch-back">
        <a href="/" className="btn btn-ghost btn-sm">
          <IconChevronLeft />
          Back
        </a>
      </div>

      {error ? (
        <div className="card watch-error">
          <p style={{ margin: '0 0 1rem' }}>{error}</p>
          <a href="/api/auth/logout?returnTo=/" className="btn btn-outline btn-sm">
            Log out and try a different account
          </a>
        </div>
      ) : (
        <>
          <h1 className="watch-title">Your videos</h1>
          {items.length === 0 ? (
            <div className="card">
              <p className="text-muted" style={{ margin: 0 }}>
                Nothing active here right now — every link shared with you has expired or been revoked.
              </p>
            </div>
          ) : (
            <ul className="bundle-list">
              {items.map((it) => (
                <li key={it.shareId} className="card bundle-item">
                  <div className="bundle-item-info">
                    <a className="bundle-item-title" href={`/watch/${it.shareId}`}>{it.title}</a>
                    <span className="share-meta">
                      expires {new Date(it.expiresAt).toLocaleString()}
                      {it.completed
                        ? ' · watched to completion'
                        : it.furthestPct
                        ? ` · watched up to ${it.furthestPct}%`
                        : it.views
                        ? ' · opened, not yet played'
                        : ' · not opened yet'}
                    </span>
                  </div>
                  <a className="btn btn-outline btn-sm" href={`/watch/${it.shareId}`}>
                    Watch
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </AppShell>
  );
}
