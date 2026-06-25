import { getSession } from '@auth0/nextjs-auth0';
import { getOrder, setOrder } from '../../../lib/order';

function isAdmin(session) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
  return session?.user?.email && admins.includes(session.user.email.toLowerCase());
}

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    const order = await getOrder();
    return res.json({ order });
  }

  if (req.method === 'POST') {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    await setOrder(order);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
