import { useEffect, useRef } from 'react';

// Wraps the Bunny embed iframe and uses the player.js protocol to (a) resume
// from the viewer's last position and (b) periodically save progress.
// Degrades gracefully: if player.js can't attach, the video still plays.
export default function ResumablePlayer({ embedUrl, title, videoId }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    let player;
    let cancelled = false;
    let duration = 0;
    let lastSaved = 0;

    const save = (seconds) => {
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, seconds, duration, title }),
      }).catch(() => {});
    };

    async function setup() {
      let Player;
      try {
        const mod = await import('player.js');
        Player = mod.default || mod.Player || mod;
      } catch (e) {
        return; // player.js unavailable — playback still works, just no resume
      }
      if (cancelled || !iframeRef.current) return;

      player = new Player(iframeRef.current);

      player.on('ready', () => {
        player.getDuration((d) => { duration = d || 0; });

        fetch(`/api/progress?videoId=${encodeURIComponent(videoId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => {
            if (p && p.seconds > 5 && (!p.duration || p.seconds < p.duration - 10)) {
              player.setCurrentTime(p.seconds);
            }
          })
          .catch(() => {});

        player.on('timeupdate', (value) => {
          if (value && value.duration) duration = value.duration;
          const seconds = value ? value.seconds : 0;
          const now = Date.now();
          if (now - lastSaved > 8000 && seconds > 0) {
            lastSaved = now;
            save(seconds);
          }
        });
      });
    }

    setup();
    return () => {
      cancelled = true;
      try { if (player && player.off) player.off('timeupdate'); } catch (e) {}
    };
  }, [videoId, title]);

  return (
    <div className="watch-player">
      <iframe ref={iframeRef} src={embedUrl} allow="fullscreen" title={title} />
    </div>
  );
}
