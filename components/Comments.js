import { useEffect, useState } from "react";
import { MAX_COMMENT_LENGTH } from "../lib/comments";

// Comments under a video (rules in lib/comments.js, gate in /api/comments).
//
// Fetched after the page renders rather than in getServerSideProps: comments
// are the one thing on this page other people change while it is open, and a
// slow comment read must never hold up the video itself.
//
// Rendered as TEXT. React escapes it, and white-space: pre-wrap keeps the
// author's line breaks; nothing a viewer types is ever interpreted as markup
// or turned into a link.
function when(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

export default function Comments({ videoId }) {
  const [comments, setComments] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/comments?videoId=${encodeURIComponent(videoId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data?.error || "Could not load comments");
          setComments([]);
          return;
        }
        setComments(Array.isArray(data?.comments) ? data.comments : []);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError("Could not load comments");
        setComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  const post = async (event) => {
    event.preventDefault();
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, text: draft }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.comment) {
        setError(data?.error || "Could not post your comment");
        return;
      }
      setComments((list) => [...(list || []), data.comment]);
      setDraft("");
    } catch {
      setError("Could not post your comment");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (comment) => {
    const question = comment.mine
      ? "Delete your comment?"
      : `Remove this comment by ${comment.name}? This cannot be undone.`;
    if (!window.confirm(question)) return;
    setError("");
    try {
      const res = await fetch(
        `/api/comments?videoId=${encodeURIComponent(videoId)}&id=${encodeURIComponent(comment.id)}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "Could not delete the comment");
        return;
      }
      setComments((list) => (list || []).filter((c) => c.id !== comment.id));
    } catch {
      setError("Could not delete the comment");
    }
  };

  const remaining = MAX_COMMENT_LENGTH - draft.length;

  return (
    <section className="comments card" aria-labelledby="comments-title">
      <h2 id="comments-title" className="chapters-title">
        Comments{comments && comments.length ? ` (${comments.length})` : ""}
      </h2>

      {comments === null ? <p className="text-muted comment-meta">Loading comments…</p> : null}
      {loadError ? <p className="comment-error">{loadError}</p> : null}
      {comments && comments.length === 0 && !loadError ? (
        <p className="text-muted comment-meta">No comments yet.</p>
      ) : null}

      {comments && comments.length ? (
        <ul className="comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="comment">
              <div className="comment-head">
                <span className="comment-name">{comment.mine ? `${comment.name} (you)` : comment.name}</span>
                {comment.email && !comment.mine ? (
                  <span className="text-muted comment-meta comment-email">{comment.email}</span>
                ) : null}
                <span className="text-muted comment-meta">{when(comment.at)}</span>
                {comment.canDelete ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm comment-delete"
                    onClick={() => remove(comment)}
                    aria-label={comment.mine ? "Delete your comment" : `Remove comment by ${comment.name}`}
                  >
                    {comment.mine ? "Delete" : "Remove"}
                  </button>
                ) : null}
              </div>
              <p className="comment-text">{comment.text}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="comment-form" onSubmit={post}>
        <label htmlFor="comment-draft" className="sr-only">
          Add a comment
        </label>
        <textarea
          id="comment-draft"
          className="input comment-input"
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder="Add a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <div className="comment-form-foot">
          <span className="text-muted comment-meta">
            Other viewers see your name, not your email.
            {remaining < 100 ? ` ${remaining} characters left.` : ""}
          </span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()}>
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
        {error ? <p className="comment-error">{error}</p> : null}
      </form>
    </section>
  );
}
