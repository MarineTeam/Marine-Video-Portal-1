import { redis, k } from './redis';

const ORDER_KEY = k('video_order');


export async function getOrder() {
  const order = await redis.get(ORDER_KEY);
  return Array.isArray(order) ? order : [];
}

export async function setOrder(order) {
  await redis.set(ORDER_KEY, order);
}

// Puts videos into the saved custom order. Any video not yet in the
// saved order (e.g. newly uploaded) goes on top, newest first, until an
// admin places it explicitly.
export function applyOrder(videos, order) {
  const byId = new Map(videos.map((v) => [v.guid, v]));
  const ordered = [];

  for (const id of order) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }

  const unordered = videos
    .filter((v) => byId.has(v.guid))
    .sort((a, b) => new Date(b.dateUploaded) - new Date(a.dateUploaded));

  return [...unordered, ...ordered];
}
