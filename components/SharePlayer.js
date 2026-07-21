import { useEffect, useRef } from 'react';
import Watermark from './Watermark';

// Wraps the Bunny embed iframe on a share-link watch page and uses the
// player.js protocol to report real playback signal — plays, furthest
// progress reached, and completion — back to the share record. Degrades
// gracefully: if player.js can't attach, the video still plays, it just
// isn't tracked beyond the page view already recorded server-side.
export default function SharePlayer({ embedUrl, title, shareId, watermarkText }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    let player;
    let cancelled = false;
    let duration = 0;
    let reportedPlay = false;
    let reportedComplete = false;
    let lastSentPct = 0;
    let lastSentAt = 0;

    const track = (type, extra) => {
      fetch(`/api/share/${shareId}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...extra }),
      }).catch(() => {});
    };

    async function setup() {
      let mod;
      try {
        mod = await import('player.js');
      } catch (e) {
        return; // library unavailable — playback still works
      }
      const ns = mod && mod.default ? mod.default : mod;
      const Player = (ns && ns.Player) || (mod && mod.Player);
      if (!Player) {
        console.warn('SharePlayer: player.js Player constructor not found');
        return;
      }
      if (cancelled || !iframeRef.current) return;

      try {
        player = new Player(iframeRef.current);
      } catch (e) {
        console.warn('SharePlayer: failed to init player.js', e);
        return;
      }

      player.on('ready', () => {
        try { player.getDuration((d) => { if (d) duration = d; }); } catch (e) {}

        player.on('play', () => {
          if (reportedPlay) return;
          reportedPlay = true;
          track('play');
        });

        player.on('timeupdate', (value) => {
          const seconds = value ? value.seconds : 0;
          if (value && value.duration) duration = value.duration;
          if (!duration || seconds <= 0) return;

          const pct = Math.min(100, Math.round((seconds / duration) * 100));
          const now = Date.now();

          if (pct >= 95 && !reportedComplete) {
            reportedComplete = true;
            lastSentPct = 100;
            track('completed');
            return;
          }

          if (pct > lastSentPct && (pct - lastSentPct >= 5 || now - lastSentAt > 15000)) {
            lastSentPct = pct;
            lastSentAt = now;
            track('progress', { pct });
          }
        });

        player.on('ended', () => {
          if (reportedComplete) return;
          reportedComplete = true;
          track('completed');
        });
      });
    }

    setup();
    return () => {
      cancelled = true;
      try {
        if (player && player.off) {
          player.off('play');
          player.off('timeupdate');
          player.off('ended');
        }
      } catch (e) {}
    };
  }, [shareId, title]);

  return (
    <div className="watch-player">
      <iframe ref={iframeRef} src={embedUrl} allow="fullscreen" title={title} />
      <Watermark text={watermarkText} />
    </div>
  );
}
