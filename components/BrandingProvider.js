import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_SITE_NAME, resolveSiteName } from '../lib/branding';

// Makes the admin-set portal name available to every page.
//
// Resolution order: the default, then the localStorage cache once mounted,
// then the authoritative value from /api/theme. The name is rendered through
// React, which escapes it — see the note on the cache effect below for why it
// deliberately does not ride the palette's pre-paint script.

const SiteNameContext = createContext(DEFAULT_SITE_NAME);
const STORAGE_KEY = 'mvp_site_name';

export function useSiteName() {
  return useContext(SiteNameContext);
}

export function BrandingProvider({ siteName, children }) {
  // Starts at the default so the first client render matches what the server
  // rendered. Reading localStorage in the initializer instead would make the
  // server emit the default while hydration emitted the stored name — a
  // hydration mismatch on every SSR page (/admin and the watch pages).
  const [name, setName] = useState(DEFAULT_SITE_NAME);

  // Seeded from the cache after mount, so a returning visitor sees their own
  // portal name without waiting for /api/theme. Unlike the palette this can't
  // be done pre-paint: that inline script in _document.js is the app's only
  // dangerouslySetInnerHTML, and feeding an admin-supplied string into it
  // would make it an XSS gadget on every page load. A name that settles one
  // frame late is a cheap price for keeping that script's input to two
  // hex-validated strings.
  useEffect(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) setName(resolveSiteName(cached));
    } catch {
      // storage blocked (private window) — the fetch below still resolves it
    }
  }, []);

  useEffect(() => {
    if (!siteName) return;
    const resolved = resolveSiteName(siteName);
    setName(resolved);
    try {
      localStorage.setItem(STORAGE_KEY, resolved);
    } catch {
      // a private window with storage blocked just loses the no-flash seed
    }
  }, [siteName]);

  return <SiteNameContext.Provider value={name}>{children}</SiteNameContext.Provider>;
}
