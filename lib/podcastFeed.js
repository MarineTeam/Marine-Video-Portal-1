// RSS 2.0 + iTunes podcast feed generation.
//
// PURE module — no Redis, no Bunny, no network. Everything it needs is passed
// in, so the XML shape is directly testable; the route assembles the inputs.
//
// MIME types are derived from the media filename rather than assumed, because
// which rendition a Bunny library exposes is a per-library configuration (see
// PODCAST_MEDIA_FILE in README.md). Getting the enclosure type wrong makes
// some apps refuse the item outright.

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
};

export function mimeForFile(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'video/mp4';
}

// XML escaping. Titles and notes are admin-authored but still untrusted for
// XML purposes: a bare & or < makes the whole feed unparseable, which means
// every subscriber's app silently stops updating rather than showing one bad
// item.
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 even when escaped.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export function rfc2822(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString();
}

// Bunny reports video length in seconds; iTunes wants HH:MM:SS (or MM:SS).
export function itunesDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// `items` are { guid, title, description, url, length, mediaUrl, mediaType,
// publishedAt }. Anything without a mediaUrl is dropped: an item with no
// enclosure is not an episode, and including it makes apps show a row that
// can never play.
export function buildFeedXml({ siteName, feedUrl, siteUrl, description, items }) {
  const playable = (items || []).filter((i) => i && i.mediaUrl);

  const entries = playable
    .map((item) => {
      const duration = item.length ? `\n      <itunes:duration>${itunesDuration(item.length)}</itunes:duration>` : '';
      const image = item.imageUrl ? `\n      <itunes:image href="${escapeXml(item.imageUrl)}" />` : '';
      const summary = item.description
        ? `\n      <description>${escapeXml(item.description)}</description>` +
          `\n      <itunes:summary>${escapeXml(item.description)}</itunes:summary>`
        : '';
      return `    <item>
      <title>${escapeXml(item.title || 'Untitled')}</title>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <link>${escapeXml(item.url)}</link>
      <pubDate>${rfc2822(item.publishedAt)}</pubDate>
      <enclosure url="${escapeXml(item.mediaUrl)}" type="${escapeXml(item.mediaType || 'video/mp4')}" length="0" />${image}${duration}${summary}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteName)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(description)}</description>
    <language>en</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <itunes:explicit>false</itunes:explicit>
    <itunes:author>${escapeXml(siteName)}</itunes:author>
    <itunes:summary>${escapeXml(description)}</itunes:summary>
    <itunes:block>Yes</itunes:block>
${entries}
  </channel>
</rss>
`;
}
