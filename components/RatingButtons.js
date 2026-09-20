import { useState } from 'react';

// The viewer's own rating of this video.
//
// Server-rendered initial state (the watch page reads it in
// getServerSideProps) rather than fetched after mount, for the same reason as
// SaveToListButton: fetching would paint "not rated" for a moment on a video
// the viewer already rated, and the correction would look like a stray click.
//
// Clicking the vote you already hold CLEARS it — the only way to take a rating
// back, and the behaviour a pressed toggle implies. Optimistic, then
// reconciled: the server's answer wins, and a refusal puts the state back and
// says why rather than leaving the viewer looking at something the server does
// not agree with.
//
// No totals here, deliberately. The viewer sees their own vote; what everyone
// else thought is not on this page. See lib/ratings.js.
export default function RatingButtons({ videoId, initialVote = null }) {
  const [vote, setVote] = useState(initialVote || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async (next) => {
    if (busy) return;
    const target = vote === next ? null : next;
    const previous = vote;
    setBusy(true);
    setError('');
    setVote(target); // optimistic

    try {
      const res = target
        ? await fetch('/api/rating', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId, vote: target }),
          })
        : await fetch(`/api/rating?videoId=${encodeURIComponent(videoId)}`, {
            method: 'DELETE',
          });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setVote(previous); // the server disagreed — put it back
        setError(data?.error || 'That did not work.');
        return;
      }
      // Trust the server's answer over the optimistic one.
      if (data && 'vote' in data) setVote(data.vote || null);
    } catch {
      setVote(previous);
      setError('That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className='rating-wrap'>
      <button
        type='button'
        className={vote === 'up' ? 'btn btn-ghost is-rated' : 'btn btn-ghost'}
        onClick={() => choose('up')}
        disabled={busy}
        aria-pressed={vote === 'up'}
        title='Worth watching'
      >
        👍
      </button>
      <button
        type='button'
        className={vote === 'down' ? 'btn btn-ghost is-rated' : 'btn btn-ghost'}
        onClick={() => choose('down')}
        disabled={busy}
        aria-pressed={vote === 'down'}
        title='Not for me'
      >
        👎
      </button>
      {error ? <span className='save-error'>{error}</span> : null}
    </span>
  );
}
