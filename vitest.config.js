import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.js'],
    // Dummy env so importing modules that construct the Redis client (e.g. lib/order)
    // doesn't throw during tests.
    env: {
      ADMIN_EMAILS: 'admin@example.com, second@example.com',
      KV_REST_API_URL: 'https://example.com',
      KV_REST_API_TOKEN: 'dummy',
    },
  },
});
