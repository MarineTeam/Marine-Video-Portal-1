import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findCues, formatTimestamp } from '../lib/captions';

// The spoken text of a recording, as a searchable, seekable list.
//
// Chapters (ResumablePlayer) are the admin's way into a long service;
// this is the machine's — every line, with the timestamp it was said at.
//
// FETCHED LAZILY, on first open. Two reasons, both about not charging every
// viewer for something most of them will not use: a 90-minute service is
// ~1,500 cues, which has no business riding inside the HTML of every watch
// page load, and a video that was never transcribed should cost zero extra
// work rather than a Redis read per visit.
//
// Degrades the same way the chapter list does: without player.js the lines
// render as plain text rather than as buttons that would do nothing.
export default function TranscriptPanel({ videoId, seekable, onSeek }) {
  const [open, setOpen] = useState(false);
  const [cues, setCues] = useState(null); // null = not fetched yet
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [query, setQuery] = useState('');
  // Survives unmount-during-fetch without setting state on a dead component.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!videoId || state === 'loading' || cues !== null) return;
    setState('loading');
    try {
      const res = await fetch(`/api/transcript/${encodeURIComponent(videoId)}`);
      // A 404 here is the ordinary 'not visible to you' answer from the gate,
      // and an untranscribed video is a 200 with an empty list. Neither is
      // worth an error message — both simply mean 'no transcript'.
      if (!res.ok) {
        if (!alive.current) return;
        setCues([]);
        setState('ready');
        return;
      }
      const data = await res.json();
      if (!alive.current) return;
      setCues(Array.isArray(data?.cues) ? data.cues : []);
      setState('ready');
    } catch {
      if (!alive.current) return;
      setState('error');
    }
  }, [videoId, state, cues]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const shown = useMemo(() => {
    if (!Array.isArray(cues)) return [];
    if (!query.trim()) return cues.map((cue, index) => ({ ...cue, index }));
    return findCues(cues, query);
  }, [cues, query]);

  // Nothing to announce until we have looked: rendering 'no transcript'
  // before the fetch would be wrong for every video that has one.
  const empty = state === 'ready' && Array.isArray(cues) && cues.length === 0;
  if (empty && !open) return null;

  return (
    <section className='transcript'>
      <button
        type='button'
        className='transcript-toggle'
        onClick={toggle}
        aria-expanded={open}
      >
        <h2 className='chapters-title'>Transcript</h2>
        <span className='transcript-chevron' aria-hidden='true'>
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div className='transcript-body'>
          {state === 'loading' ? <p className='transcript-note'>Loading…</p> : null}
          {state === 'error' ? (
            <p className='transcript-note'>The transcript could not be loaded.</p>
          ) : null}
          {empty ? (
            <p className='transcript-note'>This video has not been transcribed.</p>
          ) : null}

          {state === 'ready' && !empty ? (
            <>
              <label className='transcript-search'>
                <span className='sr-only'>Search this transcript</span>
                <input
                  type='search'
                  value={query}
                  placeholder='Search what was said…'
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>

              {query.trim() && !shown.length ? (
                <p className='transcript-note'>No lines match “{query.trim()}”.</p>
              ) : null}

              <ol className='transcript-list'>
                {shown.map((cue) => (
                  <li key={`${cue.start}-${cue.index}`} className='transcript-row'>
                    {seekable ? (
                      <button
                        type='button'
                        className='transcript-row'
                        onClick={() => onSeek?.(cue.start)}
                      >
                        <span className='chapter-time'>
                          {formatTimestamp(cue.start)}
                        </span>
                        <span className='transcript-label'>{cue.text}</span>
                      </button>
                    ) : (
                      <span className='transcript-row transcript-row--static'>
                        <span className='chapter-time'>
                          {formatTimestamp(cue.start)}
                        </span>
                        <span className='transcript-label'>{cue.text}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
