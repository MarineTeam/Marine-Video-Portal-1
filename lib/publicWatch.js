import { listVideos, getEmbedUrl } from './bunny';
import { isPublicVideo } from './publicVideos';
import { getSchedule, isVisibleNow } from './schedule';
import { getVideoMeta } from './videoMetaStore';
import { isGeoAllowed } from './geo';

// The access decision behind pages/watch/public/[id].js — the only route that
// serves a video without a session.
//
// It lives here rather than inline in the page so it can be tested directly:
// this is the single function standing between "an admin ticked one video
// public" and "the internet can read the library", and it deserves assertions
// rather than a manual check. The page is a thin renderer over its result.
//
// Every rejection returns the SAME shape and the same message, so probing the
// route cannot distinguish "no such video" from "exists but private" from
// "outside its publish window".

export const NOT_AVAILABLE = "This video isn't available.";

function refuse() {
  return { error: NOT_AVAILABLE };
}

export async function resolvePublicVideo(req, rawId) {
  const id = String(rawId || '');
  if (!id) return refuse();

  // The gate. isPublicVideo fails CLOSED on a Redis error (see
  // lib/publicVideos.js), which is the opposite of every other optional module
  // here and deliberately so.
  if (!(await isPublicVideo(id))) return refuse();

  // A public visitor has no email; the viewer branch of isGeoAllowed ignores
  // it and reads only the country header and the viewer toggle.
  if (!(await isGeoAllowed(req, null, false))) return refuse();

  const videos = await listVideos({ itemsPerPage: 100 });
  const video = videos.find((v) => v.guid === id);
  if (!video) return refuse();

  // A video scheduled for next Sunday must not leak early just because it is
  // also marked public.
  if (!isVisibleNow(await getSchedule(video.guid))) return refuse();

  const meta = await getVideoMeta(video.guid);

  return {
    embedUrl: getEmbedUrl(video.guid, 3600),
    title: video.title || 'Video',
    videoId: video.guid,
    chapters: meta?.chapters || [],
    notes: meta?.notes || '',
  };
}
