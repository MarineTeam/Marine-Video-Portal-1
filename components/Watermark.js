function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A faint, tiled, non-interactive overlay identifying who's watching — a
// deterrent against screen-recording/redistribution, not access control.
// Rendered as a repeating background image (not DOM text nodes) so it's cheap
// regardless of player size, and pointer-events:none so it never intercepts
// clicks meant for the player underneath.
export default function Watermark({ text }) {
  if (!text) return null;
  const safe = escapeXml(text);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='160'>` +
    `<text x='10' y='90' font-family='sans-serif' font-size='15' fill='rgba(255,255,255,0.22)' transform='rotate(-22 160 80)'>${safe}</text>` +
    `</svg>`;
  const backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

  return <div className="video-watermark" style={{ backgroundImage }} aria-hidden="true" />;
}
