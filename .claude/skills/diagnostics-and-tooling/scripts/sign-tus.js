#!/usr/bin/env node
/*
 * sign-tus.js — recompute the Bunny TUS upload signature exactly as the server does.
 *
 * PURPOSE: when a browser TUS upload to https://video.bunnycdn.com/tusupload
 * returns HTTP 401, compute the signature locally and compare it against the
 * one the server returned from POST /api/admin/upload ({videoId, libraryId,
 * signature, expires}). Same inputs but different signature => the deployed
 * env values differ from what you think they are (whitespace, stale deploy,
 * wrong library). Same signature => the values match and the 401 is elsewhere
 * (expiry semantics, clock, Bunny-side).
 *
 * FORMULA (mirrored line-for-line from lib/bunny.js signTusUpload, as fixed by
 * commit 8e81183 "Fix TUS upload 401: revert to seconds expiry, trim env values"):
 *   expires   = Math.floor(Date.now() / 1000) + 86400      // Unix SECONDS
 *   signature = sha256hex(libraryId + apiKey + expires + videoId)
 * with libraryId and apiKey .trim()-ed before hashing.
 *
 * USAGE:
 *   node sign-tus.js <LIBRARY_ID> <API_KEY> <VIDEO_ID> [EXPIRES]
 *   # or via env:
 *   BUNNY_LIBRARY_ID=... BUNNY_API_KEY=... VIDEO_ID=... [EXPIRES=...] node sign-tus.js
 *
 * EXPIRES is the ABSOLUTE Unix timestamp in seconds — i.e. the exact value of
 * the AuthorizationExpire header / the `expires` field the server returned.
 * Pass the server's value to reproduce the server's signature bit-for-bit;
 * omit it to mint a fresh signature with the server's default 24h window.
 *
 * Output prints libraryId, videoId, expires and signature — NEVER the API key.
 *
 * VERIFICATION STATUS: verified by inspection only — Node is not installed on
 * the authoring machine (session record, 2026-07-10, maintainer-confirmed).
 * Formula mirrored from lib/bunny.js signTusUpload, which is covered by the
 * repo's vitest suite in CI. Runs where Node (any version >= 14) is available.
 */
'use strict';

const crypto = require('crypto');

const [, , argLib, argKey, argVideo, argExpires] = process.argv;
const libraryId = (argLib || process.env.BUNNY_LIBRARY_ID || '').trim();
const apiKey = (argKey || process.env.BUNNY_API_KEY || '').trim();
const videoId = (argVideo || process.env.VIDEO_ID || '').trim();
const expiresRaw = (argExpires || process.env.EXPIRES || '').trim();

if (!libraryId || !apiKey || !videoId) {
  console.error('Usage: node sign-tus.js <LIBRARY_ID> <API_KEY> <VIDEO_ID> [EXPIRES]');
  console.error('   or: BUNNY_LIBRARY_ID=... BUNNY_API_KEY=... VIDEO_ID=... [EXPIRES=...] node sign-tus.js');
  console.error('EXPIRES = absolute Unix timestamp in SECONDS (the AuthorizationExpire header value).');
  process.exit(2);
}

let expires;
if (expiresRaw) {
  expires = parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires)) {
    console.error(`EXPIRES is not a number: ${expiresRaw}`);
    process.exit(2);
  }
  if (expires > 100000000000) {
    console.error(
      'WARNING: EXPIRES looks like MILLISECONDS. Bunny TUS expects SECONDS — ' +
        'the milliseconds variant was exactly the 401 bug reverted by commit 8e81183.'
    );
  }
} else {
  // Same default window as lib/bunny.js signTusUpload(videoId, expiresInSeconds = 86400).
  expires = Math.floor(Date.now() / 1000) + 86400;
}

const signature = crypto
  .createHash('sha256')
  .update(`${libraryId}${apiKey}${expires}${videoId}`)
  .digest('hex');

// Never print the API key.
console.log(JSON.stringify({ libraryId, videoId, expires, signature }, null, 2));
