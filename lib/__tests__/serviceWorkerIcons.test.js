// public/sw.js — which icons a push notification shows.
//
// The service worker is plain browser code outside lib/, so it is pinned here
// by reading the file: the notification ICON follows the admin-set app icon
// (through /api/app-icon/192, which falls back to the built-in file), and the
// BADGE stays the built-in one, because Android draws a badge as a silhouette
// of its transparent pixels and an opaque uploaded picture would be a blob.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sw = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');

describe('push notification icons', () => {
  it('uses the app-icon route for the notification icon', () => {
    expect(sw).toMatch(/icon:\s*['"]\/api\/app-icon\/192['"]/);
  });

  it('keeps the built-in file for the badge', () => {
    expect(sw).toMatch(/badge:\s*['"]\/icon-192\.png['"]/);
  });
});
