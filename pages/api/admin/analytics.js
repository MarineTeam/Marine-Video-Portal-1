import { getSession } from '@auth0/nextjs-auth0';
import { isAdmin } from '../../../lib/auth';
import { listVideos, getLibraryStatistics } from '../../../lib/bunny';

export default async function handler(req, res) {
  const session = await getSession(req, res);
  if (!session || !isAdmin(session?.user?.email)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'GET') return res.status(405).end();

  const videos = await listVideos({ itemsPerPage: 100 });
  const rows = videos.map((v) => ({
    id: v.guid,
    title: v.title || 'Untitled',
    views: v.views || 0,
    length: v.length || 0,
    watchTime: v.totalWatchTime || 0,
  }));

  const totalViews = rows.reduce((s, v) => s + v.views, 0);
  const totalWatchHours = Math.round(rows.reduce((s, v) => s + v.watchTime, 0) / 3600 * 10) / 10;
  const topVideos = [...rows].sort((a, b) => b.views - a.views).slice(0, 10);

  // 30-day views chart is a bonus — if the statistics endpoint fails, the rest
  // of the dashboard still renders.
  let chart = [];
  let last30Views = 0;
  try {
    const to = new Date();
    const from = new Date(Date.now() - 30 * 86400000);
    const stats = await getLibraryStatistics({
      dateFrom: from.toISOString().slice(0, 10),
      dateTo: to.toISOString().slice(0, 10),
    });
    const vc = stats.viewsChart || {};
    chart = Object.entries(vc)
      .map(([date, count]) => ({ date, count: Number(count) || 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
    last30Views = chart.reduce((s, d) => s + d.count, 0);
  } catch (e) {
    // statistics optional
  }

  res.json({ totalViews, totalWatchHours, videoCount: rows.length, topVideos, chart, last30Views });
}
