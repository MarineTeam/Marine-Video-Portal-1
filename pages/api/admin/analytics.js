import { requireCapability } from '../../../lib/roles';
import { getLibraryStatistics } from '../../../lib/bunny';
import { listAllVideos } from '../../../lib/videoLibrary';
import { withMonitorApi } from '../../../lib/monitor';

async function handler(req, res) {
  const auth = await requireCapability(req, res, 'analytics:read');
  if (!auth) return;
  if (req.method !== 'GET') return res.status(405).end();

  // Every video, so total views, watch time and most-watched are not drawn
  // from the newest 100 alone.
  const { videos, truncated, total } = await listAllVideos();
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

  res.json({
    totalViews,
    totalWatchHours,
    videoCount: total,
    // The library is larger than one read; the totals cover `covered` videos.
    truncated,
    covered: rows.length,
    topVideos,
    chart,
    last30Views,
  });
}

export default withMonitorApi(handler);
