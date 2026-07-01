import { getSession } from '@auth0/nextjs-auth0';
import { isAdmin } from '../../../lib/auth';
import { listCollections, createCollection, deleteCollection } from '../../../lib/bunny';
import { logAudit } from '../../../lib/audit';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  const actor = session?.user?.email;
  if (!session || !isAdmin(actor)) return res.status(403).json({ error: 'Forbidden' });

  if (req.method === 'GET') {
    try {
      return res.json(await listCollections());
    } catch (e) {
      return res.status(502).json({ error: e.message || 'Failed to list collections' });
    }
  }

  if (req.method === 'POST') {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    try {
      const collection = await createCollection(name.trim());
      await logAudit(actor, 'collection.create', name.trim());
      return res.json(collection);
    } catch (e) {
      return res.status(502).json({ error: e.message || 'Failed to create collection' });
    }
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await deleteCollection(id);
      await logAudit(actor, 'collection.delete', id);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: e.message || 'Failed to delete collection' });
    }
  }

  res.status(405).end();
}
