import { useState } from 'react';

// Toggles one video in the viewer's saved list.
//
// The initial state is SERVER-RENDERED (the watch page reads it in
// getServerSideProps) rather than fetched after mount. Fetching would paint
// 'Save' for a moment on a video that is already saved, and the correction
// would look like the click had failed.
//
// Optimistic, then reconciled: the label flips immediately and the server's
// answer wins. A refusal — a full list, a lost session, a rate limit — puts
// the label back and says why, rather than leaving the viewer looking at a
// state the server does not agree with.
export default function SaveToListButton({ videoId, initialSaved = false }) {
  const [saved, setSaved] = useState(Boolean(initialSaved));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = async () => {
    if (busy) return;
    const next = !saved;
    setBusy(true);
    setError('');
    setSaved(next); // optimistic

    try {
      const res = next
        ? await fetch('/api/mylist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
          })
        : await fetch(`/api/mylist?videoId=${encodeURIComponent(videoId)}`, {
            method: 'DELETE',
          });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setSaved(!next); // the server disagreed — put it back
        setError(data?.error || 'That did not work.');
        return;
      }
      const data = await res.json().catch(() => null);
      // Trust the server's answer over the optimistic one.
      if (typeof data?.saved === 'boolean') setSaved(data.saved);
    } catch {
      setSaved(!next);
      setError('That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className='save-wrap'>
      <button
        type='button'
        className={saved ? 'btn btn-ghost is-saved' : 'btn btn-ghost'}
        onClick={toggle}
        disabled={busy}
        aria-pressed={saved}
      >
        {saved ? '✓ In my list' : '+ Save to my list'}
      </button>
      {error ? <span className='save-error'>{error}</span> : null}
    </span>
  );
}
