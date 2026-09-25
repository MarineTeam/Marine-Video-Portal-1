// ESLint 9 flat config. Next 16 removed `next lint`, so this replaces
// .eslintrc.json; the rules below are the ones that file carried.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const browserGlobals = [
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'fetch', 'console', 'process', 'URL', 'URLSearchParams', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'AbortController', 'Notification', 'Image', 'Blob',
  'File', 'FileReader', 'FormData', 'atob', 'btoa', 'Intl', 'crypto',
  'TextEncoder', 'confirm', 'alert',
];

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', 'public/sw.js'] },
  ...nextCoreWebVitals,
  {
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // caughtErrors: 'none' keeps ESLint 8's default: an unused `catch (e)` is
      // this repo's idiom for a deliberately swallowed, best-effort failure.
      'no-unused-vars': ['warn', { caughtErrors: 'none' }],
      '@next/next/no-html-link-for-pages': 'off',
      // The pages fetch on mount with plain fetch + setState (no data
      // library). This rule, new with eslint-config-next 16, flags that whole
      // pattern, including setState that only happens after an await.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // no-undef on server code: a call to something never imported lints clean
    // under eslint-config-next and only fails at runtime, as a 500.
    files: ['lib/**/*.js', 'pages/api/**/*.js', 'proxy.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        fetch: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', crypto: 'readonly', Response: 'readonly',
        Request: 'readonly', Headers: 'readonly', structuredClone: 'readonly',
        AbortController: 'readonly', globalThis: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    // The same rule on browser code — pages and components. Both sibling
    // repos shipped a page that referenced a variable from ANOTHER component
    // (2026-09): lint was clean, and one page crashed for every unapproved
    // visitor while the other silently never loaded its queue. The globals
    // are listed rather than taken from a package, so a new one is a
    // deliberate line here and a missing one fails lint loudly.
    //
    // NEGATIVE CONTROL: reference an undeclared name in any page or component
    // and `npm run lint` must fail with "'<name>' is not defined".
    files: ['pages/**/*.js', 'components/**/*.js'],
    ignores: ['pages/api/**'],
    languageOptions: {
      globals: Object.fromEntries(browserGlobals.map((name) => [name, 'readonly'])),
    },
    rules: { 'no-undef': 'error' },
  },
];

export default config;
