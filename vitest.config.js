import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.js'],
    // Dummy env so importing modules that construct the Redis client (e.g. lib/order)
    // or the Auth0 SDK (e.g. lib/roles) doesn't throw during tests. Same
    // present-and-well-formed-but-not-valid values the CI build uses.
    env: {
      ADMIN_EMAILS: 'admin@example.com, second@example.com',
      KV_REST_API_URL: 'https://example.com',
      KV_REST_API_TOKEN: 'dummy',
      AUTH0_SECRET: '0000000000000000000000000000000000000000000000000000000000000000',
      AUTH0_BASE_URL: 'https://example.com',
      AUTH0_ISSUER_BASE_URL: 'https://example.us.auth0.com',
      AUTH0_CLIENT_ID: 'dummy',
      AUTH0_CLIENT_SECRET: 'dummy',
    },
  },
});
