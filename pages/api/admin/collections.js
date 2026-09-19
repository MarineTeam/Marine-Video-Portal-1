import { requireCapability } from '../../../lib/roles';
import { listCollections, createCollection, deleteCollection } from '../../../lib/bunny';
import { logAudit } from '../../../lib/audit';
import { withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'videos:manage');
  if (!auth) return;
  const actor = auth.email;

  if (req.method === 'GET') {
    try {
      return res.json(await listCollections());
    } catch (e) {
      return res.status(502).json({ error: e.message || 'Failed to list collections' });
    }
  }

  if (req.method === 'POST') {
    const { name } = req.body || {};
    // typeof, not truthiness: a wrong-typed name (array, number, object) is
    // truthy, so it used to reach .trim() and throw a TypeError that surfaced
    // as a 500. Reject the TYPE rather than coercing it — String(['x']) would
    // have quietly become 'x', a name nobody sent.
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
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

export default withMonitorApi(handler);
