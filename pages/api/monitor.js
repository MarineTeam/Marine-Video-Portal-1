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
    // NB: on a serverless platform these describe the single function instance
    // that happened to serve THIS request, not "the server" — each API route is
    // its own function, and uptime restarts on every cold start. The client
    // labels them per-instance so the numbers aren't read as fleet-wide.
    uptime: process.uptime(),
    serverless: Boolean(process.env.VERCEL),
    node: process.version,
  });
}
