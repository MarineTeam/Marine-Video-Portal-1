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
    let savedSeconds = 0;
    let didSeek = false;
    let lastSaved = 0;

    const save = (seconds) => {
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, seconds: Math.floor(seconds), duration, title }),
      }).catch(() => {});
    };

    const trySeek = () => {
      if (didSeek || savedSeconds <= 5) return;
      if (duration && savedSeconds >= duration - 10) return;
      didSeek = true;
      try { player.setCurrentTime(savedSeconds); } catch (e) {}
    };

    async function setup() {
      let mod;
      try {
        mod = await import('player.js');
      } catch (e) {
        return; // library unavailable — playback still works
      }
      // player.js exports { Player, Receiver, ... }; under webpack interop the
      // whole namespace is on .default, so the constructor is default.Player.
      const ns = mod && mod.default ? mod.default : mod;
      const Player = (ns && ns.Player) || (mod && mod.Player);
      if (!Player) {
        console.warn('ResumablePlayer: player.js Player constructor not found');
        return;
      }
      if (cancelled || !iframeRef.current) return;

      // Load the saved position before the player is ready so we can seek immediately.
      try {
        const r = await fetch(`/api/progress?videoId=${encodeURIComponent(videoId)}`);
        const p = r.ok ? await r.json() : null;
        if (p && typeof p.seconds === 'number') savedSeconds = p.seconds;
        if (p && p.duration) duration = p.duration;
      } catch (e) {}

      try {
        player = new Player(iframeRef.current);
      } catch (e) {
        console.warn('ResumablePlayer: failed to init player.js', e);
        return;
      }

      player.on('ready', () => {
        try { player.getDuration((d) => { if (d) duration = d; }); } catch (e) {}
        trySeek();

        player.on('timeupdate', (value) => {
          const seconds = value ? value.seconds : 0;
          if (value && value.duration) duration = value.duration;
          // Fallback: some players ignore a seek issued while paused, so retry
          // once as soon as playback actually starts.
          if (!didSeek && savedSeconds > 5 && seconds < savedSeconds - 2) {
            trySeek();
            return;
          }
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
