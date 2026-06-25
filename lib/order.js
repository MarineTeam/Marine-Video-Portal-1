import { redis } from './redis';

const ORDER_KEY = 'video_order';

export async function getOrder() {
  const order = await redis.get(ORDER_KEY);
  return Array.isArray(order) ? order : [];
}

export async function setOrder(order) {
  await redis.set(ORDER_KEY, order);
}

// Puts videos into the saved custom order. Any video not yet in the
// saved order (e.g. newly uploaded) keeps its original position and
// gets appended at the end.
export function applyOrder(videos, order) {
  const byId = new Map(videos.map((v) => [v.guid, v]));
  const ordered = [];

  for (const id of order) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }

  for (const v of videos) {
    if (byId.has(v.guid)) {
      ordered.push(v);
    }
  }

  return ordered;
}
