import { getSession } from '@auth0/nextjs-auth0';
import { listVideos } from '../../../lib/bunny';
import { getOrder, applyOrder } from '../../../lib/order';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });

  const videos = await listVideos({ itemsPerPage: 100 });
  const order = await getOrder();
  const ordered = applyOrder(videos, order);

  res.json(ordered.map((v) => ({ id: v.guid, title: v.title, dateUploaded: v.dateUploaded })));
}
