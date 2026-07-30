import { getSession } from '@auth0/nextjs-auth0';
import { monitorEnabled } from '../../lib/monitor';

// Lightweight process stats for the Query Monitor panel (memory, uptime).
// Requires a session (any logged-in user, not admin-only) so perf details
// about the server process are never exposed to logged-out visitors.
export default async function handler(req, res) {
  if (!monitorEnabled()) return res.status(404).json({ enabled: false });

  const session = await getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const mem = process.memoryUsage();
  res.json({
    enabled: true,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    uptime: process.uptime(),
    node: process.version,
  });
}
