import { useEffect, useRef, useState } from 'react';
import Watermark from './Watermark';
import { linkAtTime } from '../lib/timestampLink';
import { formatTimestamp } from '../lib/videoMeta';

// Wraps the Bunny embed iframe and uses the player.js protocol to (a) resume
// from the viewer's last position and (b) periodically save progress.
// Degrades gracefully: if player.js can't attach, the video still plays.
// `onSeekAvailable` is called with a seek(seconds) function once player.js has
// attached, and with null on teardown. The watch page uses it to decide whether
// to render chapters as buttons or as plain text — if player.js never loads,
// playback still works and the chapter list degrades instead of offering dead
// controls.
// `trackProgress` false attaches player.js for chapter seeking but skips both
// the resume lookup and the progress saves. The public watch page uses it:
// there is no signed-in viewer, so /api/progress would 401 on every tick and
// there is no email to key a position against anyway.
export default function ResumablePlayer({ embedUrl, title, videoId, watermarkText, onSeekAvailable, trackProgress = true, startAt = null }) {
  const iframeRef = useRef(null);
  // Where playback is now, for the copy-link button, and whether the player
  // is talking to us at all.
  const [position, setPosition] = useState(0);
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let player;
    let cancelled = false;
    let duration = 0;
    let savedSeconds = 0;
    // A ?t= in the address is an explicit request for a moment. It beats the
    // saved resume position — the viewer followed a link to a point — and it
    // changes the seek RULES below, which were written for a resume value:
    // a resume under five seconds is not worth restoring, but a link to 0:03
    // is exactly what was asked for.
    const explicitStart = Number.isFinite(startAt) && startAt >= 0;
    if (explicitStart) savedSeconds = Math.floor(startAt);
    let didSeek = false;
    let lastSaved = 0;

    const save = (seconds) => {
      if (!trackProgress) return;
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, seconds: Math.floor(seconds), duration, title }),
      }).catch(() => {});
    };

    const trySeek = () => {
      if (didSeek) return;
      if (!explicitStart) {
        if (savedSeconds <= 5) return;
        // Near the end, a resume would restart the video for no reason. An
        // explicit link is honoured even there — that is where the
        // interesting bit might be.
        if (duration && savedSeconds >= duration - 10) return;
      }
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

      // Load the saved position before the player is ready so we can seek
      // immediately — unless a link already named the moment, in which case
      // there is nothing to look up and nothing it could override.
      if (trackProgress && !explicitStart) {
        try {
          const r = await fetch(`/api/progress?videoId=${encodeURIComponent(videoId)}`);
          const p = r.ok ? await r.json() : null;
          if (p && typeof p.seconds === 'number') savedSeconds = p.seconds;
          if (p && p.duration) duration = p.duration;
        } catch (e) {}
      }

      try {
        player = new Player(iframeRef.current);
      } catch (e) {
        console.warn('ResumablePlayer: failed to init player.js', e);
        return;
      }

      player.on('ready', () => {
        setCanCopy(true);
        try { player.getDuration((d) => { if (d) duration = d; }); } catch (e) {}
        trySeek();

        if (typeof onSeekAvailable === 'function') {
          onSeekAvailable((seconds) => {
            // A manual jump supersedes the pending resume-seek; without this the
            // resume retry below would yank the viewer back out of the chapter
            // they just picked.
            didSeek = true;
            try { player.setCurrentTime(Math.max(0, Math.floor(seconds))); } catch (e) {}
          });
        }

        player.on('timeupdate', (value) => {
          const seconds = value ? value.seconds : 0;
          setPosition(Math.floor(seconds || 0));
          if (value && value.duration) duration = value.duration;
          // Fallback: some players ignore a seek issued while paused, so retry
          // once as soon as playback actually starts.
          if (!didSeek && (explicitStart || savedSeconds > 5) && seconds < savedSeconds - 2) {
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
      if (typeof onSeekAvailable === 'function') onSeekAvailable(null);
      try { if (player && player.off) player.off('timeupdate'); } catch (e) {}
    };
    // onSeekAvailable is intentionally excluded: the watch page passes a stable
    // useCallback, and including it would re-run setup (and re-create the
    // player) on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, title, trackProgress, startAt]);

  // Copies the address of this moment. Uses the CURRENT page URL rather than
  // rebuilding one, so it works from any route this player appears on without
  // knowing their shapes.
  async function copyMoment() {
    try {
      await navigator.clipboard.writeText(linkAtTime(window.location.href, position));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // Clipboard refused (insecure context, or permission). Leaving the
      // button as it was beats pretending it worked.
    }
  }

  return (
    <>
      <div className="watch-player">
        <iframe
          ref={iframeRef}
          src={embedUrl}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
          title={title}
        />
        <Watermark text={watermarkText} />
      </div>
      {/* Only once player.js is talking to us: a button that copied 0:00 for
          every video would be worse than no button. */}
      {canCopy ? (
        <div className="admin-row" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={copyMoment}>
            {copied ? 'Link copied' : `Copy link at ${formatTimestamp(position)}`}
          </button>
        </div>
      ) : null}
    </>
  );
}
