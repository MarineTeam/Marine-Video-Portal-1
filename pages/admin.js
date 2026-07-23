import { useUser } from '@auth0/nextjs-auth0/client';
import { getSession } from '@auth0/nextjs-auth0';
import { useEffect, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import NotifyButton from '../components/NotifyButton';
import { IconTrash, IconCopy, IconGrip, IconPencil, IconSearch, IconCheck, IconX } from '../components/icons';
import { applyTheme, DEFAULT_THEME, PRESETS, isValidHex } from '../lib/theme';
import { isAdmin as isAdminEmail } from '../lib/auth';
import { isGeoAllowed } from '../lib/geo';

// Server-side gate: only admins can load the admin page at all. The client-side
// checks and per-route 403s remain as defense in depth, but this stops a
// logged-in non-admin from ever receiving the admin UI shell.
export async function getServerSideProps({ req, res }) {
  const session = await getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/api/auth/login?returnTo=/admin', permanent: false } };
  }
  if (!isAdminEmail(session.user?.email)) {
    return { redirect: { destination: '/', permanent: false } };
  }
  // Admin geo whitelist (off by default) — a bypass-listed admin (see
  // ADMIN_GEO_BYPASS_EMAILS in lib/geo.js) always passes this regardless.
  if (!(await isGeoAllowed(req, session.user.email.toLowerCase(), true))) {
    return { redirect: { destination: '/', permanent: false } };
  }
  return { props: {} };
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatDuration(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function Admin() {
  const { user, isLoading } = useUser();
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [activeShares, setActiveShares] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [newViewerEmail, setNewViewerEmail] = useState('');
  const [videoCount, setVideoCount] = useState(2);
  const [expiresHours, setExpiresHours] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('videos');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [themeSaved, setThemeSaved] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const [uploadErrorMsg, setUploadErrorMsg] = useState('');
  const [bulkEmails, setBulkEmails] = useState('');
  const [videoQuery, setVideoQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [dragOverId, setDragOverId] = useState(null);
  const [audit, setAudit] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [collections, setCollections] = useState([]);
  const [newCollection, setNewCollection] = useState('');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [mailEnabled, setMailEnabled] = useState(false);
  const [notifyShare, setNotifyShare] = useState({});
  const [shareMsg, setShareMsg] = useState({});
  const [resendMsg, setResendMsg] = useState({});
  const [bulkSelected, setBulkSelected] = useState({});
  const [bulkRecipients, setBulkRecipients] = useState('');
  const [bulkExpiresHours, setBulkExpiresHours] = useState('72');
  const [bulkNotify, setBulkNotify] = useState(true);
  const [bulkSharing, setBulkSharing] = useState(false);
  const [bulkShareResult, setBulkShareResult] = useState(null);
  const [bulkVideoQuery, setBulkVideoQuery] = useState('');
  const [shareSelected, setShareSelected] = useState({});
  const [lastShareClickIndex, setLastShareClickIndex] = useState(null);
  const shareShiftKeyRef = useRef(false);
  const [bulkActionMsg, setBulkActionMsg] = useState('');
  const [bulkActing, setBulkActing] = useState(false);
  const [extendHours, setExtendHours] = useState('72');
  const [watermarkGlobal, setWatermarkGlobal] = useState(false);
  const [watermarkExempt, setWatermarkExempt] = useState([]);
  const [newExemptEmail, setNewExemptEmail] = useState('');
  const [shareWatermark, setShareWatermark] = useState({});
  const [bulkWatermark, setBulkWatermark] = useState('default');
  const [videoAnalytics, setVideoAnalytics] = useState({});
  const [videoOpsSelected, setVideoOpsSelected] = useState({});
  const [videoOpsCollection, setVideoOpsCollection] = useState('');
  const [videoOpsMsg, setVideoOpsMsg] = useState('');
  const [videoOpsActing, setVideoOpsActing] = useState(false);
  const [geoViewerEnabled, setGeoViewerEnabled] = useState(false);
  const [geoViewerCountries, setGeoViewerCountries] = useState([]);
  const [geoAdminEnabled, setGeoAdminEnabled] = useState(false);
  const [geoAdminCountries, setGeoAdminCountries] = useState([]);
  const [geoSaved, setGeoSaved] = useState(false);
  const fileInputRef = useRef(null);
  const uploadRef = useRef(null);
  const uploadVideoIdRef = useRef(null);
  const dragIdRef = useRef(null);

  async function fetchVideos() {
    const r = await fetch('/api/admin/videos');
    if (!r.ok) throw new Error('Forbidden — this account is not an admin');
    setVideos(await r.json());
  }

  useEffect(() => {
    if (!user) return;

    fetchVideos().catch((e) => setError(e.message));
    fetch('/api/admin/viewers').then((r) => r.json()).then(setViewers);
    fetch('/api/admin/settings').then((r) => r.json()).then((d) => { setVideoCount(d.count); setMailEnabled(Boolean(d.mailEnabled)); });
    fetch('/api/admin/shares').then((r) => r.json()).then(setActiveShares);
    fetch('/api/theme').then((r) => r.json()).then(setTheme).catch(() => {});
    fetch('/api/admin/collections').then((r) => (r.ok ? r.json() : [])).then(setCollections).catch(() => {});
    fetch('/api/admin/watermark')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setWatermarkGlobal(Boolean(d.global)); setWatermarkExempt(d.exempt || []); } })
      .catch(() => {});
    fetch('/api/admin/geo')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setGeoViewerEnabled(Boolean(d.viewer?.enabled));
        setGeoViewerCountries(d.viewer?.countries || []);
        setGeoAdminEnabled(Boolean(d.admin?.enabled));
        setGeoAdminCountries(d.admin?.countries || []);
      })
      .catch(() => {});
  }, [user]);

  // Load the per-video analytics rollup the first time the Videos or Analytics
  // tab is opened (and refresh on revisit) — same lazy pattern as Activity/Analytics.
  useEffect(() => {
    if (!user || (tab !== 'videos' && tab !== 'analytics')) return;
    fetch('/api/admin/video-analytics').then((r) => (r.ok ? r.json() : {})).then(setVideoAnalytics).catch(() => {});
  }, [user, tab]);

  // While any video is still encoding (status 0–3), re-poll so progress updates.
  useEffect(() => {
    const encoding = videos.some((v) => typeof v.status === 'number' && v.status < 4);
    if (!encoding) return;
    const t = setTimeout(() => { fetchVideos().catch(() => {}); }, 4000);
    return () => clearTimeout(t);
  }, [videos]);

  // Load the audit log the first time the Activity tab is opened (and refresh on revisit).
  useEffect(() => {
    if (!user || tab !== 'activity') return;
    fetch('/api/admin/audit').then((r) => (r.ok ? r.json() : [])).then(setAudit).catch(() => {});
  }, [user, tab]);

  // Load analytics when the Analytics tab is opened (and refresh on revisit).
  useEffect(() => {
    if (!user || tab !== 'analytics') return;
    fetch('/api/admin/analytics').then((r) => (r.ok ? r.json() : null)).then(setAnalytics).catch(() => {});
  }, [user, tab]);

  // Live-preview a palette change across the whole page as the admin edits.
  function previewTheme(next) {
    setTheme(next);
    setThemeSaved(false);
    applyTheme(next);
  }

  function setAccent(which, value) {
    previewTheme({ ...theme, [which]: value });
  }

  async function saveTheme() {
    if (!isValidHex(theme.accent1) || !isValidHex(theme.accent2)) {
      alert('Both colors must be valid #rrggbb hex values.');
      return;
    }
    const res = await fetch('/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || `Failed to save (status ${res.status})`); return; }
    try { localStorage.setItem('mvp_theme', JSON.stringify(theme)); } catch (e) {}
    setThemeSaved(true);
    setTimeout(() => setThemeSaved(false), 2000);
  }

  function failUpload(message, err) {
    if (err) console.error('Video upload failed:', err);
    setUploading(false);
    setUploadError(true);
    setUploadErrorMsg(message || 'Upload failed');
  }

  async function beginUpload() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadError(false);
    setUploadErrorMsg('');
    setUploadPct(0);

    let meta;
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: uploadTitle.trim() || uploadFile.name }),
      });
      meta = await res.json();
      if (!res.ok) throw new Error(meta.error || `Create-video failed (HTTP ${res.status})`);
      if (!meta.videoId) throw new Error('Server did not return a video id');
    } catch (e) {
      failUpload(`Couldn't start upload: ${e.message}`, e);
      return;
    }

    uploadVideoIdRef.current = meta.videoId;

    let Upload;
    try {
      ({ Upload } = await import('tus-js-client'));
    } catch (e) {
      failUpload('Upload library failed to load — try redeploying so tus-js-client installs.', e);
      return;
    }

    const upload = new Upload(uploadFile, {
      endpoint: 'https://video.bunnycdn.com/tusupload',
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        AuthorizationSignature: meta.signature,
        AuthorizationExpire: String(meta.expires),
        VideoId: meta.videoId,
        LibraryId: String(meta.libraryId),
      },
      metadata: { filetype: uploadFile.type, title: meta.title },
      onError: (err) => {
        const status = err?.originalResponse?.getStatus?.();
        failUpload(`Upload failed${status ? ` (HTTP ${status})` : ''}: ${err?.message || err}`, err);
      },
      onProgress: (sent, total) => setUploadPct(Math.round((sent / total) * 100)),
      onSuccess: async () => {
        uploadRef.current = null;
        uploadVideoIdRef.current = null;
        setUploading(false);
        setUploadError(false);
        setUploadErrorMsg('');
        setUploadFile(null);
        setUploadTitle('');
        setUploadPct(0);
        if (fileInputRef.current) fileInputRef.current.value = '';
        await fetchVideos().catch(() => {});
      },
    });
    uploadRef.current = upload;
    upload.start();
  }

  // Resume the same upload after a failure — TUS picks up where it left off.
  function retryUpload() {
    if (!uploadRef.current) { beginUpload(); return; }
    setUploadError(false);
    setUploadErrorMsg('');
    setUploading(true);
    uploadRef.current.start();
  }

  // Stop the in-flight upload and remove the half-created video from bunny.net.
  async function cancelUpload() {
    if (uploadRef.current) {
      try { await uploadRef.current.abort(); } catch (e) {}
      uploadRef.current = null;
    }
    const id = uploadVideoIdRef.current;
    uploadVideoIdRef.current = null;
    setUploading(false);
    setUploadError(false);
    setUploadPct(0);
    if (id) {
      await fetch('/api/admin/videos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      await fetchVideos().catch(() => {});
    }
  }

  async function removeVideo(v) {
    if (!confirm(`Delete "${v.title || 'Untitled'}"? This permanently removes it from bunny.net.`)) return;
    const res = await fetch('/api/admin/videos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Failed to delete');
      return;
    }
    setVideos((prev) => prev.filter((x) => x.id !== v.id));
  }

  function onDropFile(e) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('video/')) { alert('Please drop a video file.'); return; }
    setUploadFile(f);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function addViewer() {
    if (!newViewerEmail.trim()) return;
    await fetch('/api/admin/viewers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newViewerEmail }),
    });
    setNewViewerEmail('');
    const r = await fetch('/api/admin/viewers');
    setViewers(await r.json());
  }

  async function removeViewer(email) {
    await fetch('/api/admin/viewers', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setViewers((prev) => prev.filter((v) => v.email !== email));
  }

  async function addBulkViewers() {
    const text = bulkEmails.trim();
    if (!text) return;
    const res = await fetch('/api/admin/viewers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to add viewers'); return; }
    setBulkEmails('');
    const r = await fetch('/api/admin/viewers');
    setViewers(await r.json());
  }

  function startRename(v) { setEditingId(v.id); setEditTitle(v.title || ''); }
  function cancelRename() { setEditingId(null); setEditTitle(''); }

  async function saveRename(v) {
    const title = editTitle.trim();
    if (!title) return;
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, title }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Rename failed');
      return;
    }
    setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, title } : x)));
    cancelRename();
  }

  async function addCollection() {
    const name = newCollection.trim();
    if (!name) return;
    const res = await fetch('/api/admin/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to create collection'); return; }
    setNewCollection('');
    setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function removeCollection(id) {
    if (!confirm('Delete this collection? Videos stay, but become uncategorized.')) return;
    const res = await fetch('/api/admin/collections', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete'); return; }
    setCollections((prev) => prev.filter((c) => c.id !== id));
    setVideos((prev) => prev.map((v) => (v.collectionId === id ? { ...v, collectionId: '' } : v)));
  }

  async function assignCollection(v, collectionId) {
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, collectionId }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to update'); return; }
    setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, collectionId } : x)));
  }

  async function assignWatermarkMode(v, watermarkMode) {
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, watermarkMode }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to update'); return; }
    setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, watermarkMode } : x)));
  }

  async function saveWatermarkGlobal(next) {
    const res = await fetch('/api/admin/watermark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ global: next }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to save'); return; }
    setWatermarkGlobal(next);
  }

  async function addWatermarkExempt() {
    const email = newExemptEmail.trim();
    if (!email) return;
    const res = await fetch('/api/admin/watermark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to add exemption'); return; }
    setNewExemptEmail('');
    setWatermarkExempt((prev) => [...new Set([...prev, email.toLowerCase()])].sort());
  }

  async function removeWatermarkExempt(email) {
    await fetch('/api/admin/watermark', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setWatermarkExempt((prev) => prev.filter((e) => e !== email));
  }

  function selectedVideoOpsIds() {
    return Object.keys(videoOpsSelected).filter((id) => videoOpsSelected[id]);
  }

  async function bulkDeleteVideos() {
    const ids = selectedVideoOpsIds();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} video(s)? This permanently removes them from bunny.net.`)) return;
    setVideoOpsActing(true);
    setVideoOpsMsg('');
    try {
      const res = await fetch('/api/admin/videos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setVideoOpsMsg(data.error || 'Delete failed'); return; }
      const results = data.results || ids.map((id) => ({ id, ok: true }));
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      setVideos((prev) => prev.filter((v) => !okIds.has(v.id)));
      const failed = results.filter((r) => !r.ok);
      setVideoOpsMsg(
        failed.length === 0
          ? `Deleted ${okIds.size}/${ids.length}.`
          : `Deleted ${okIds.size}/${ids.length} (failed: ${failed.map((f) => f.error || 'error').join('; ')}).`
      );
      setVideoOpsSelected({});
    } catch (e) {
      setVideoOpsMsg('Delete failed');
    } finally {
      setVideoOpsActing(false);
    }
  }

  async function bulkAssignVideoCollection() {
    const ids = selectedVideoOpsIds();
    if (ids.length === 0) return;
    setVideoOpsActing(true);
    setVideoOpsMsg('');
    try {
      const res = await fetch('/api/admin/videos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, collectionId: videoOpsCollection }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setVideoOpsMsg(data.error || 'Update failed'); return; }
      const results = data.results || ids.map((id) => ({ id, ok: true }));
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      setVideos((prev) => prev.map((v) => (okIds.has(v.id) ? { ...v, collectionId: videoOpsCollection } : v)));
      const failed = results.filter((r) => !r.ok);
      setVideoOpsMsg(
        failed.length === 0
          ? `Assigned ${okIds.size}/${ids.length}.`
          : `Assigned ${okIds.size}/${ids.length} (failed: ${failed.map((f) => f.error || 'error').join('; ')}).`
      );
      setVideoOpsSelected({});
    } catch (e) {
      setVideoOpsMsg('Update failed');
    } finally {
      setVideoOpsActing(false);
    }
  }

  function onDragStartRow(e, id) { dragIdRef.current = id; e.dataTransfer.effectAllowed = 'move'; }
  function onDragOverRow(e, id) { e.preventDefault(); if (id !== dragOverId) setDragOverId(id); }
  function onDragEndRow() { dragIdRef.current = null; setDragOverId(null); }

  function onDropRow(e, id) {
    e.preventDefault();
    const fromId = dragIdRef.current;
    dragIdRef.current = null;
    setDragOverId(null);
    if (!fromId || fromId === id) return;
    const from = videos.findIndex((v) => v.id === fromId);
    const to = videos.findIndex((v) => v.id === id);
    if (from < 0 || to < 0) return;
    const next = [...videos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setVideos(next);
    saveOrder(next.map((v) => v.id));
  }

  async function refreshShares() {
    const r = await fetch('/api/admin/shares');
    setActiveShares(await r.json());
  }

  async function revokeShare(shareId) {
    await fetch('/api/admin/shares', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId }),
    });
    setActiveShares((prev) =>
      prev.map((s) => (s.shareId === shareId ? { ...s, revoked: true } : s))
    );
  }

  async function unrevokeShare(shareId) {
    await fetch('/api/admin/shares', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId }),
    });
    setActiveShares((prev) =>
      prev.map((s) => (s.shareId === shareId ? { ...s, revoked: false } : s))
    );
  }

  async function deleteShareForever(shareId) {
    if (!confirm('Permanently delete this link? This cannot be undone or un-revoked.')) return;
    const res = await fetch('/api/admin/shares', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId, permanent: true }),
    });
    if (res.ok) {
      setActiveShares((prev) => prev.filter((s) => s.shareId !== shareId));
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to delete');
    }
  }

  async function resendShare(shareId) {
    setResendMsg((prev) => ({ ...prev, [shareId]: 'Sending…' }));
    try {
      const res = await fetch('/api/admin/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareId }),
      });
      const data = await res.json().catch(() => ({}));
      setResendMsg((prev) => ({ ...prev, [shareId]: res.ok ? 'Email sent' : (data.error || 'Send failed') }));
    } catch (e) {
      setResendMsg((prev) => ({ ...prev, [shareId]: 'Send failed' }));
    }
    setTimeout(() => setResendMsg((prev) => ({ ...prev, [shareId]: '' })), 4000);
  }

  function selectedShareIds() {
    return Object.keys(shareSelected).filter((id) => shareSelected[id]);
  }

  // Shift-click range select, same convention as Gmail/file explorers: the
  // checkbox's onClick (fires before onChange) stashes whether shift was
  // held, then onChange applies the just-toggled state to every item
  // between the last-clicked checkbox and this one instead of just this one.
  function handleShareCheckboxChange(index, shareId, checked) {
    const shift = shareShiftKeyRef.current;
    shareShiftKeyRef.current = false;
    if (shift && lastShareClickIndex !== null) {
      const start = Math.min(lastShareClickIndex, index);
      const end = Math.max(lastShareClickIndex, index);
      setShareSelected((prev) => {
        const next = { ...prev };
        for (let i = start; i <= end; i++) {
          next[activeShares[i].shareId] = checked;
        }
        return next;
      });
    } else {
      setShareSelected((prev) => ({ ...prev, [shareId]: checked }));
    }
    setLastShareClickIndex(index);
  }

  // Bulk actions never fail the whole batch on one bad item — each is
  // processed independently server-side; here we just summarize the results.
  async function bulkAction(method, extra, successLabel) {
    const shareIds = selectedShareIds();
    if (shareIds.length === 0) return;
    setBulkActing(true);
    setBulkActionMsg('');
    try {
      const res = await fetch('/api/admin/shares', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareIds, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBulkActionMsg(data.error || 'Action failed');
        return;
      }
      const results = data.results || shareIds.map((id) => ({ shareId: id, ok: true }));
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      setBulkActionMsg(
        failed.length === 0
          ? `${successLabel}: ${okCount}/${shareIds.length}.`
          : `${successLabel}: ${okCount}/${shareIds.length} (failed: ${failed.map((f) => f.error || 'error').join('; ')}).`
      );
      setShareSelected({});
      refreshShares();
    } catch (e) {
      setBulkActionMsg('Action failed');
    } finally {
      setBulkActing(false);
    }
  }

  function bulkResendSelected() { bulkAction('POST', {}, 'Resent'); }
  function bulkRevokeSelected() { bulkAction('DELETE', {}, 'Revoked'); }
  function bulkUnrevokeSelected() { bulkAction('PATCH', {}, 'Un-revoked'); }
  function bulkDeleteForeverSelected() {
    if (!confirm('Permanently delete the selected links? This cannot be undone. Only already-revoked links will be deleted.')) return;
    bulkAction('DELETE', { permanent: true }, 'Deleted');
  }
  function bulkExtendSelected() {
    const hours = parseInt(extendHours) || 0;
    if (hours <= 0) return alert('Enter a positive number of hours');
    bulkAction('PUT', { addHours: hours }, `Extended by ${hours}h`);
  }

  async function handleShare(video) {
    const email = (emails[video.id] || '').trim();
    if (!email) return alert("Enter the recipient's email first");
    const hours = parseInt(expiresHours[video.id]) || 72;
    const notify = mailEnabled && Boolean(notifyShare[video.id]);
    const res = await fetch('/api/admin/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos: [{ id: video.id, title: video.title }],
        emails: [email],
        expiresInHours: hours,
        notify,
        watermarkMode: shareWatermark[video.id] || 'default',
      }),
    });
    const data = await res.json();
    const watchUrl = data.links?.[0]?.watchUrl;
    setShareLinks((prev) => ({ ...prev, [video.id]: watchUrl }));
    setShareMsg((prev) => ({
      ...prev,
      [video.id]: notify ? (data.emailedTo?.includes(email) ? `Link emailed to ${email}` : 'Link created — email failed to send') : '',
    }));
    refreshShares();
  }

  // Bulk share: any number of selected videos × any number of recipients.
  async function handleBulkShare() {
    const videoIds = Object.keys(bulkSelected).filter((id) => bulkSelected[id]);
    const emailList = [...new Set(
      bulkRecipients.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    )];
    if (videoIds.length === 0) return alert('Select at least one video');
    if (emailList.length === 0) return alert('Enter at least one recipient email');

    setBulkSharing(true);
    setBulkShareResult(null);
    try {
      const res = await fetch('/api/admin/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videos: videoIds.map((id) => ({ id, title: videos.find((v) => v.id === id)?.title || '' })),
          emails: emailList,
          expiresInHours: parseInt(bulkExpiresHours) || 72,
          notify: mailEnabled && bulkNotify,
          watermarkMode: bulkWatermark,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'Failed to create links'); return; }
      setBulkShareResult({
        linkCount: data.links?.length || 0,
        recipients: data.recipients || emailList.length,
        emailedTo: data.emailedTo || [],
        notify: mailEnabled && bulkNotify,
      });
      setBulkSelected({});
      setBulkRecipients('');
      refreshShares();
    } finally {
      setBulkSharing(false);
    }
  }

  async function sendBroadcast() {
    const body = broadcastBody.trim();
    if (!body) return;
    setBroadcasting(true);
    setBroadcastMsg('');
    try {
      const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: broadcastTitle.trim(), body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBroadcastMsg(data.error || `Failed (status ${res.status})`);
        return;
      }
      setBroadcastMsg(
        `Sent to ${data.sent} device${data.sent === 1 ? '' : 's'}` +
          (data.pruned ? ` · ${data.pruned} stale removed` : '') +
          '.'
      );
      setBroadcastTitle('');
      setBroadcastBody('');
    } catch (e) {
      setBroadcastMsg('Broadcast failed');
    } finally {
      setBroadcasting(false);
    }
  }

  async function saveVideoCount() {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: videoCount }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || `Failed to save (status ${res.status})`); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveGeoToggles(next) {
    const res = await fetch('/api/admin/geo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Failed to save (status ${res.status})`);
      return;
    }
    setGeoSaved(true);
    setTimeout(() => setGeoSaved(false), 2000);
  }

  async function saveOrder(idList) {
    await fetch('/api/admin/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: idList }),
    });
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  // Bunny video status: 0–3 still encoding, 4 finished, 5/6 failed.
  function videoStatusBadge(v) {
    if (typeof v.status !== 'number') return null;
    if (v.status === 5 || v.status === 6) {
      return <span className="badge badge-error">Failed</span>;
    }
    if (v.status >= 4) return null;
    return <span className="badge badge-processing">Processing {v.encodeProgress || 0}%</span>;
  }

  if (isLoading) {
    return (
      <AppShell isAdmin>
        <p className="text-muted">Loading…</p>
      </AppShell>
    );
  }

  if (!user) {
    return (
      <AppShell>
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center' }}>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>You need to be signed in.</p>
          <a href="/api/auth/login" className="btn btn-primary btn-sm">Sign in</a>
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <div className="card" style={{ padding: '1.5rem' }}>
          <p className="text-muted">{error}</p>
        </div>
      </AppShell>
    );
  }

  const q = videoQuery.trim().toLowerCase();
  const shownVideos = q ? videos.filter((v) => (v.title || '').toLowerCase().includes(q)) : videos;

  const bulkQ = bulkVideoQuery.trim().toLowerCase();
  const bulkShownVideos = bulkQ ? videos.filter((v) => (v.title || '').toLowerCase().includes(bulkQ)) : videos;
  const bulkSelectedCount = Object.values(bulkSelected).filter(Boolean).length;

  return (
    <AppShell isAdmin>
      <div className="admin-topbar">
        <h1 className="admin-page-title">Admin</h1>
        <nav className="admin-tabs">
          {[
            { id: 'videos', label: 'Videos', count: videos.length },
            { id: 'viewers', label: 'Viewers', count: viewers.length },
            { id: 'shares', label: 'Shares', count: activeShares.length },
            { id: 'settings', label: 'Settings', count: null },
            { id: 'activity', label: 'Activity', count: null },
            { id: 'analytics', label: 'Analytics', count: null },
          ].map((t) => (
            <button
              key={t.id}
              className={`admin-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="tab-count">{t.count}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="admin-stack">

        {tab === 'settings' && (
        <>
        {/* Appearance */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Appearance</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Choose the accent palette used across the portal for every visitor.
          </p>

          <div className="theme-preview" />

          <div className="preset-grid">
            {PRESETS.map((p) => {
              const active = theme.accent1 === p.accent1 && theme.accent2 === p.accent2;
              return (
                <button
                  key={p.name}
                  className="preset-btn"
                  data-active={active}
                  onClick={() => previewTheme({ accent1: p.accent1, accent2: p.accent2 })}
                >
                  <span
                    className="preset-swatch"
                    style={{ background: `linear-gradient(135deg, ${p.accent1}, ${p.accent2})` }}
                  />
                  {p.name}
                </button>
              );
            })}
          </div>

          <div className="color-fields">
            <div className="color-field">
              <label className="label">Accent 1</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  className="color-swatch"
                  value={theme.accent1}
                  onChange={(e) => setAccent('accent1', e.target.value)}
                />
                <input
                  type="text"
                  className="input input-sm color-hex"
                  value={theme.accent1}
                  onChange={(e) => setAccent('accent1', e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="color-field">
              <label className="label">Accent 2</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  className="color-swatch"
                  value={theme.accent2}
                  onChange={(e) => setAccent('accent2', e.target.value)}
                />
                <input
                  type="text"
                  className="input input-sm color-hex"
                  value={theme.accent2}
                  onChange={(e) => setAccent('accent2', e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>

            <button onClick={saveTheme} className="btn btn-primary btn-sm">
              {themeSaved ? 'Saved!' : 'Save palette'}
            </button>
          </div>
        </div>

        {/* Homepage settings */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Homepage Settings</h2>
          <div className="admin-row">
            <label className="label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>
              Videos shown:
            </label>
            <input
              type="number"
              min="1"
              max="1000"
              value={videoCount}
              onChange={(e) => setVideoCount(e.target.value)}
              className="input input-sm"
              style={{ width: '5rem', flex: 'none' }}
            />
            <button onClick={saveVideoCount} className="btn btn-primary btn-sm">
              {saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        {/* Geo location whitelist */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Geo Location Whitelist</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Restricts video access by country, detected from Vercel&rsquo;s edge network
            (so this only takes effect on a Vercel deployment). The country lists are set
            via environment variables and shown here read-only; each list has its own
            live on/off toggle, both off by default. A country that can&rsquo;t be
            determined is never blocked.
          </p>

          <h3 className="analytics-subhead" style={{ marginTop: 0 }}>Viewers</h3>
          <label className="share-notify" style={{ marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              checked={geoViewerEnabled}
              onChange={(e) => { setGeoViewerEnabled(e.target.checked); saveGeoToggles({ viewerEnabled: e.target.checked }); }}
            />
            Restrict viewer access to <code>GEO_WHITELIST</code>
          </label>
          <p className="text-muted" style={{ marginBottom: '1.25rem' }}>
            {geoViewerCountries.length > 0 ? geoViewerCountries.join(', ') : 'No countries configured.'}
          </p>

          <h3 className="analytics-subhead">Admins</h3>
          <label className="share-notify" style={{ marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              checked={geoAdminEnabled}
              onChange={(e) => { setGeoAdminEnabled(e.target.checked); saveGeoToggles({ adminEnabled: e.target.checked }); }}
            />
            Restrict admin access to <code>ADMIN_GEO_WHITELIST</code>
          </label>
          <p className="text-muted" style={{ marginBottom: 0 }}>
            {geoAdminCountries.length > 0 ? geoAdminCountries.join(', ') : 'No countries configured.'}
            {' '}Admins listed in <code>ADMIN_GEO_BYPASS_EMAILS</code> always bypass this check,
            regardless of country — set that up in advance for any admin who travels, since
            env var changes need a redeploy to take effect.
          </p>
          {geoSaved && <p className="text-muted" style={{ marginTop: '0.75rem' }}>Saved!</p>}
        </div>

        {/* Watermark */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Watermark</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Overlays the viewer&rsquo;s email on playback as a deterrent against screen
            recording. Layered: an exemption always wins; below that, a share&rsquo;s own
            setting beats a video&rsquo;s, which beats this global default.
          </p>
          <label className="share-notify" style={{ marginBottom: '1rem' }}>
            <input
              type="checkbox"
              checked={watermarkGlobal}
              onChange={(e) => saveWatermarkGlobal(e.target.checked)}
            />
            Watermark video by default
          </label>

          <h3 className="analytics-subhead" style={{ marginTop: 0 }}>Exempt from watermarking</h3>
          <div className="admin-row">
            <input
              type="email"
              placeholder="viewer@example.com"
              value={newExemptEmail}
              onChange={(e) => setNewExemptEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWatermarkExempt()}
              className="input input-sm"
            />
            <button onClick={addWatermarkExempt} className="btn btn-primary btn-sm">Add</button>
          </div>
          {watermarkExempt.length > 0 ? (
            <ul className="viewer-list">
              {watermarkExempt.map((email) => (
                <li key={email} className="viewer-item">
                  <span className="viewer-email">{email}</span>
                  <button
                    onClick={() => removeWatermarkExempt(email)}
                    className="btn btn-icon"
                    title="Remove exemption"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mt-4">No exemptions — everyone follows the layered setting above.</p>
          )}
        </div>

        {/* Notifications */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Notifications</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Approved viewers who opt in get a push notification when a new video is ready.
            Send a manual announcement to everyone below. (Inactive until VAPID keys are set —
            see the README.)
          </p>
          <div style={{ marginBottom: '1rem' }}>
            <NotifyButton />
          </div>
          <div className="admin-row" style={{ marginBottom: 10 }}>
            <input
              className="input input-sm"
              placeholder="Title (optional)"
              value={broadcastTitle}
              onChange={(e) => setBroadcastTitle(e.target.value)}
              disabled={broadcasting}
            />
          </div>
          <textarea
            className="input"
            rows={3}
            placeholder="Message to send to all approved viewers…"
            value={broadcastBody}
            onChange={(e) => setBroadcastBody(e.target.value)}
            disabled={broadcasting}
          />
          <div className="admin-row" style={{ marginTop: 10 }}>
            <button
              onClick={sendBroadcast}
              className="btn btn-primary btn-sm"
              disabled={broadcasting || !broadcastBody.trim()}
            >
              {broadcasting ? 'Sending…' : 'Send broadcast'}
            </button>
            {broadcastMsg && <span className="text-muted">{broadcastMsg}</span>}
          </div>
        </div>

        {/* Content protection */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Content Protection</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            How this portal keeps videos private.
          </p>
          <ul className="protection-list">
            <li>
              <span className="dot dot-ok" />
              Every play uses a fresh signed, time-limited token — never a public URL.
            </li>
            <li>
              <span className="dot dot-ok" />
              Share links require login and an email match before the video plays.
            </li>
            <li>
              <span className="dot dot-warn" />
              Direct bunny.net CDN file URLs stay public unless you enable{' '}
              <strong>Block Direct URL File Access</strong> in your bunny.net library&rsquo;s Security
              settings. This app never exposes those URLs, but enabling it closes the gap for anyone
              who obtains one.
            </li>
          </ul>
          <a
            className="btn btn-outline btn-sm"
            href="https://dash.bunny.net/stream"
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 14 }}
          >
            Open bunny.net dashboard
          </a>
        </div>
        </>
        )}

        {tab === 'viewers' && (
        <>
        {/* Approved viewers */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Approved Viewers</h2>
          <div className="admin-row">
            <input
              type="email"
              placeholder="viewer@example.com"
              value={newViewerEmail}
              onChange={(e) => setNewViewerEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addViewer()}
              className="input input-sm"
            />
            <button onClick={addViewer} className="btn btn-primary btn-sm">Add</button>
          </div>

          <details className="bulk-add">
            <summary>Bulk add several at once</summary>
            <textarea
              className="input"
              rows={4}
              placeholder="Paste emails separated by commas, spaces, or new lines"
              value={bulkEmails}
              onChange={(e) => setBulkEmails(e.target.value)}
            />
            <button onClick={addBulkViewers} className="btn btn-primary btn-sm" style={{ marginTop: 10 }}>
              Add all
            </button>
          </details>

          {viewers.length > 0 ? (
            <ul className="viewer-list">
              {viewers.map((v) => (
                <li key={v.email} className="viewer-item">
                  <span className="viewer-email">{v.email}</span>
                  <span className="viewer-seen">{v.lastSeen ? `seen ${timeAgo(v.lastSeen)}` : 'never seen'}</span>
                  <button
                    onClick={() => removeViewer(v.email)}
                    className="btn btn-icon"
                    title="Remove viewer"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mt-4">No approved viewers yet.</p>
          )}
        </div>
        </>
        )}

        {tab === 'shares' && (
        <>
        {/* Bulk share: N videos × M recipients, each pair gets its own link */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Bulk Share</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Pick one or more videos and one or more recipients. Every video/recipient pair gets its
            own private link, independently revocable. Each recipient gets a single email listing
            only their own links.
          </p>

          <div className="bulk-share-videos">
            <div className="search-box">
              <IconSearch className="search-icon" />
              <input
                className="input input-sm"
                placeholder="Filter videos…"
                value={bulkVideoQuery}
                onChange={(e) => setBulkVideoQuery(e.target.value)}
              />
            </div>
            <ul className="bulk-video-picklist">
              {bulkShownVideos.map((v) => (
                <li key={v.id} className="bulk-video-pick">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(bulkSelected[v.id])}
                      onChange={(e) =>
                        setBulkSelected((prev) => ({ ...prev, [v.id]: e.target.checked }))
                      }
                    />
                    {v.title}
                  </label>
                </li>
              ))}
              {bulkShownVideos.length === 0 && <p className="text-muted">No videos match.</p>}
            </ul>
          </div>

          <textarea
            className="input"
            placeholder="Recipient emails — separate with commas, spaces, or new lines"
            value={bulkRecipients}
            onChange={(e) => setBulkRecipients(e.target.value)}
            rows={3}
            style={{ width: '100%', marginTop: '0.75rem', resize: 'vertical' }}
          />

          <div className="admin-video-share" style={{ marginTop: '0.75rem' }}>
            <input
              type="number"
              placeholder="72h"
              min="1"
              max="720"
              value={bulkExpiresHours}
              onChange={(e) => setBulkExpiresHours(e.target.value)}
              className="input input-sm"
              style={{ width: '5rem', flex: 'none' }}
              title="Hours until links expire"
            />
            <select
              className="input input-sm"
              value={bulkWatermark}
              onChange={(e) => setBulkWatermark(e.target.value)}
              style={{ width: '9rem', flex: 'none' }}
              title="Watermark for these links"
            >
              <option value="default">Watermark: Default</option>
              <option value="always">Watermark: Always</option>
              <option value="never">Watermark: Never</option>
            </select>
            {mailEnabled && (
              <label className="share-notify">
                <input
                  type="checkbox"
                  checked={bulkNotify}
                  onChange={(e) => setBulkNotify(e.target.checked)}
                />
                Email each recipient their links
              </label>
            )}
            <button
              onClick={handleBulkShare}
              className="btn btn-outline btn-sm"
              disabled={bulkSharing || bulkSelectedCount === 0}
            >
              {bulkSharing
                ? 'Creating…'
                : `Create links${bulkSelectedCount ? ` (${bulkSelectedCount} video${bulkSelectedCount > 1 ? 's' : ''})` : ''}`}
            </button>
          </div>

          {bulkShareResult && (
            <p className="share-sent-msg text-muted" style={{ marginTop: '0.5rem' }}>
              Created {bulkShareResult.linkCount} link{bulkShareResult.linkCount === 1 ? '' : 's'} for{' '}
              {bulkShareResult.recipients} recipient{bulkShareResult.recipients === 1 ? '' : 's'}.
              {bulkShareResult.notify &&
                ` Emailed ${bulkShareResult.emailedTo.length}/${bulkShareResult.recipients}.`}
            </p>
          )}
        </div>

        {/* Active share links */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Active Private Links</h2>
          {activeShares.length === 0 ? (
            <p className="text-muted">No active links.</p>
          ) : (
            <>
            <div className="bulk-action-bar">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={activeShares.length > 0 && selectedShareIds().length === activeShares.length}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selectedShareIds().length > 0 && selectedShareIds().length < activeShares.length;
                    }
                  }}
                  onChange={(e) =>
                    setShareSelected(
                      e.target.checked
                        ? Object.fromEntries(activeShares.map((s) => [s.shareId, true]))
                        : {}
                    )
                  }
                />
                Select all
              </label>
              <span className="text-muted">
                {selectedShareIds().length > 0 ? `${selectedShareIds().length} selected` : 'Select links for bulk actions'}
              </span>
              {mailEnabled && (
                <button
                  onClick={bulkResendSelected}
                  className="btn btn-outline btn-sm"
                  disabled={bulkActing || selectedShareIds().length === 0}
                >
                  Resend {selectedShareIds().length || ''}
                </button>
              )}
              <input
                type="number"
                min="1"
                max="720"
                value={extendHours}
                onChange={(e) => setExtendHours(e.target.value)}
                className="input input-sm"
                style={{ width: '4.5rem', flex: 'none' }}
                title="Hours to add"
              />
              <button
                onClick={bulkExtendSelected}
                className="btn btn-outline btn-sm"
                disabled={bulkActing || selectedShareIds().length === 0}
              >
                Extend {selectedShareIds().length || ''}
              </button>
              <button
                onClick={bulkRevokeSelected}
                className="btn btn-destructive btn-sm"
                disabled={bulkActing || selectedShareIds().length === 0}
              >
                Revoke {selectedShareIds().length || ''}
              </button>
              <button
                onClick={bulkUnrevokeSelected}
                className="btn btn-outline btn-sm"
                disabled={bulkActing || selectedShareIds().length === 0}
              >
                Un-revoke {selectedShareIds().length || ''}
              </button>
              <button
                onClick={bulkDeleteForeverSelected}
                className="btn btn-destructive btn-sm"
                disabled={bulkActing || selectedShareIds().length === 0}
                title="Only already-revoked links in the selection will be deleted"
              >
                Delete forever {selectedShareIds().length || ''}
              </button>
              {bulkActionMsg && <span className="share-resend-msg text-muted">{bulkActionMsg}</span>}
            </div>
            <ul className="shares-list">
              {activeShares.map((s, i) => (
                <li key={s.shareId} className="share-item">
                  <input
                    type="checkbox"
                    checked={Boolean(shareSelected[s.shareId])}
                    onClick={(e) => { shareShiftKeyRef.current = e.shiftKey; }}
                    onChange={(e) => handleShareCheckboxChange(i, s.shareId, e.target.checked)}
                    style={{ marginTop: '4px' }}
                  />
                  <div className="share-info">
                    <span className="share-title">
                      {s.title}
                      {s.viewedAt
                        ? <span className="badge badge-ok">Viewed</span>
                        : <span className="badge badge-muted">Not viewed</span>}
                      {s.completed && <span className="badge badge-ok">Completed</span>}
                      {s.bundleId && <span className="badge badge-muted">Bundled</span>}
                      {s.expiresAt < Date.now() && <span className="badge badge-muted">Expired</span>}
                      {s.revoked && <span className="badge badge-error">Revoked</span>}
                    </span>
                    <span className="share-meta">
                      {s.email} &mdash; expires {new Date(s.expiresAt).toLocaleString()}
                      {s.views ? ` · ${s.views} view${s.views === 1 ? '' : 's'}` : ''}
                      {s.lastViewedAt ? ` (last ${timeAgo(s.lastViewedAt)})` : ''}
                    </span>
                    <span className="share-meta">
                      {s.plays ? `${s.plays} play${s.plays === 1 ? '' : 's'}` : 'not played'}
                      {typeof s.furthestPct === 'number' && s.furthestPct > 0
                        ? ` · furthest ${s.furthestPct}%`
                        : ''}
                    </span>
                  </div>
                  <div className="share-actions">
                    {mailEnabled && (
                      <>
                        <button
                          onClick={() => resendShare(s.shareId)}
                          className="btn btn-outline btn-sm"
                          title={`Resend the link to ${s.email}`}
                        >
                          Resend email
                        </button>
                        {resendMsg[s.shareId] && (
                          <span className="share-resend-msg text-muted">{resendMsg[s.shareId]}</span>
                        )}
                      </>
                    )}
                    {s.bundleId && (
                      <button
                        onClick={() => copyLink(`${window.location.origin}/watch/bundle/${s.bundleId}`)}
                        className="btn btn-outline btn-sm"
                        title={`Copy ${s.email}'s bundle link`}
                      >
                        Copy bundle link
                      </button>
                    )}
                    {s.revoked ? (
                      <>
                        <button
                          onClick={() => unrevokeShare(s.shareId)}
                          className="btn btn-outline btn-sm"
                        >
                          Un-revoke
                        </button>
                        <button
                          onClick={() => deleteShareForever(s.shareId)}
                          className="btn btn-destructive btn-sm"
                          title="Permanently delete — cannot be undone"
                        >
                          Delete permanently
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => revokeShare(s.shareId)}
                        className="btn btn-destructive btn-sm"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            </>
          )}
        </div>

        </>
        )}

        {tab === 'videos' && (
        <>
        {/* Upload video */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Upload Video</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Upload a new video straight to bunny.net. It appears in the library below once processing finishes.
          </p>

          <div
            className={`dropzone${dragOver ? ' drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragOver(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
            onDrop={onDropFile}
          >
            <p className="dropzone-hint">
              {uploadFile ? (
                <>Selected: <span className="font-medium">{uploadFile.name}</span></>
              ) : (
                <>Drag &amp; drop a video here, or pick a file below</>
              )}
            </p>

            <div className="upload-controls">
              <input
                type="text"
                placeholder="Title (optional — defaults to file name)"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                className="input input-sm"
                disabled={uploading}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="file-input"
                disabled={uploading}
              />
              <button
                onClick={beginUpload}
                className="btn btn-primary btn-sm"
                disabled={!uploadFile || uploading}
              >
                {uploading ? `Uploading ${uploadPct}%` : 'Upload'}
              </button>
            </div>

            {uploading && (
              <div className="upload-status">
                <div className="progress" aria-label="Upload progress">
                  <div className="progress-bar" style={{ width: `${uploadPct}%` }} />
                </div>
                <button onClick={cancelUpload} className="btn btn-outline btn-sm">Cancel</button>
              </div>
            )}

            {uploadError && !uploading && (
              <div className="upload-status upload-failed">
                <span className="badge badge-error">Failed</span>
                {uploadErrorMsg && <span className="upload-error-msg">{uploadErrorMsg}</span>}
                <button onClick={retryUpload} className="btn btn-primary btn-sm">Retry</button>
                <button onClick={cancelUpload} className="btn btn-ghost btn-sm">Discard</button>
              </div>
            )}
          </div>
        </div>

        {/* Collections */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Collections</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Group videos into categories. Viewers can filter the homepage by collection.
          </p>
          <div className="admin-row">
            <input
              className="input input-sm"
              placeholder="New collection name"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCollection()}
            />
            <button onClick={addCollection} className="btn btn-primary btn-sm">Add</button>
          </div>
          {collections.length > 0 && (
            <ul className="viewer-list">
              {collections.map((c) => (
                <li key={c.id} className="viewer-item">
                  <span className="viewer-email">{c.name}</span>
                  <span className="viewer-seen">{c.videoCount ?? 0} videos</span>
                  <button
                    onClick={() => removeCollection(c.id)}
                    className="btn btn-icon"
                    title="Delete collection"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Video library */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Video Library</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Drag the handle to set the order videos appear on the homepage.
          </p>

          <div className="search-box">
            <IconSearch className="search-icon" />
            <input
              className="input input-sm"
              placeholder="Search videos…"
              value={videoQuery}
              onChange={(e) => setVideoQuery(e.target.value)}
            />
            {videoQuery && (
              <button className="btn btn-icon" onClick={() => setVideoQuery('')} title="Clear search">
                <IconX />
              </button>
            )}
          </div>

          {shownVideos.length > 0 && (
            <div className="bulk-action-bar">
              <span className="text-muted">
                {selectedVideoOpsIds().length > 0 ? `${selectedVideoOpsIds().length} selected` : 'Select videos for bulk actions'}
              </span>
              {collections.length > 0 && (
                <>
                  <select
                    className="input input-sm"
                    value={videoOpsCollection}
                    onChange={(e) => setVideoOpsCollection(e.target.value)}
                    style={{ width: '10rem', flex: 'none' }}
                  >
                    <option value="">No collection</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={bulkAssignVideoCollection}
                    className="btn btn-outline btn-sm"
                    disabled={videoOpsActing || selectedVideoOpsIds().length === 0}
                  >
                    Assign {selectedVideoOpsIds().length || ''}
                  </button>
                </>
              )}
              <button
                onClick={bulkDeleteVideos}
                className="btn btn-destructive btn-sm"
                disabled={videoOpsActing || selectedVideoOpsIds().length === 0}
              >
                Delete {selectedVideoOpsIds().length || ''}
              </button>
              {videoOpsMsg && <span className="share-resend-msg text-muted">{videoOpsMsg}</span>}
            </div>
          )}

          {shownVideos.length === 0 ? (
            <p className="text-muted mt-4">
              {videoQuery ? 'No videos match your search.' : 'No videos yet.'}
            </p>
          ) : (
          <ul className="admin-video-list">
            {shownVideos.map((v) => (
              <li
                key={v.id}
                className={`admin-video-item${dragOverId === v.id ? ' drag-over' : ''}`}
                onDragOver={!q ? (e) => onDragOverRow(e, v.id) : undefined}
                onDrop={!q ? (e) => onDropRow(e, v.id) : undefined}
              >
                <div className="admin-video-header">
                  <input
                    type="checkbox"
                    checked={Boolean(videoOpsSelected[v.id])}
                    onChange={(e) => setVideoOpsSelected((prev) => ({ ...prev, [v.id]: e.target.checked }))}
                  />
                  {v.thumbnail && (
                    <img
                      className="admin-video-thumb"
                      src={v.thumbnail}
                      alt=""
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  )}
                  <span
                    className="drag-handle"
                    draggable={!q}
                    onDragStart={(e) => onDragStartRow(e, v.id)}
                    onDragEnd={onDragEndRow}
                    title={q ? 'Clear search to reorder' : 'Drag to reorder'}
                  >
                    <IconGrip />
                  </span>

                  {editingId === v.id ? (
                    <>
                      <input
                        className="input input-sm"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(v);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <button onClick={() => saveRename(v)} className="btn btn-icon" title="Save">
                        <IconCheck />
                      </button>
                      <button onClick={cancelRename} className="btn btn-icon" title="Cancel">
                        <IconX />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="admin-video-title">{v.title}</span>
                      {videoStatusBadge(v)}
                      <button onClick={() => startRename(v)} className="btn btn-icon" title="Rename">
                        <IconPencil />
                      </button>
                      <button
                        onClick={() => removeVideo(v)}
                        className="btn btn-icon"
                        title="Delete video"
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </div>

                {collections.length > 0 && (
                  <div className="admin-video-collection">
                    <label className="collection-label">Collection</label>
                    <select
                      className="input input-sm"
                      value={v.collectionId || ''}
                      onChange={(e) => assignCollection(v, e.target.value)}
                    >
                      <option value="">No collection</option>
                      {collections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="admin-video-collection">
                  <label className="collection-label">Watermark</label>
                  <select
                    className="input input-sm"
                    value={v.watermarkMode || 'default'}
                    onChange={(e) => assignWatermarkMode(v, e.target.value)}
                  >
                    <option value="default">Default</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                </div>

                <div className="admin-video-share">
                  <input
                    type="email"
                    placeholder="recipient@example.com"
                    value={emails[v.id] || ''}
                    onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    className="input input-sm"
                  />
                  <input
                    type="number"
                    placeholder="72h"
                    min="1"
                    max="720"
                    value={expiresHours[v.id] || ''}
                    onChange={(e) => setExpiresHours((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    className="input input-sm"
                    style={{ width: '5rem', flex: 'none' }}
                    title="Hours until link expires"
                  />
                  <select
                    className="input input-sm"
                    value={shareWatermark[v.id] || 'default'}
                    onChange={(e) => setShareWatermark((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    style={{ width: '9rem', flex: 'none' }}
                    title="Watermark for this link"
                  >
                    <option value="default">Watermark: Default</option>
                    <option value="always">Watermark: Always</option>
                    <option value="never">Watermark: Never</option>
                  </select>
                  <button onClick={() => handleShare(v)} className="btn btn-outline btn-sm">
                    Create link
                  </button>
                </div>

                {mailEnabled && (
                  <label className="share-notify">
                    <input
                      type="checkbox"
                      checked={Boolean(notifyShare[v.id])}
                      onChange={(e) => setNotifyShare((prev) => ({ ...prev, [v.id]: e.target.checked }))}
                    />
                    Email the link to the recipient
                  </label>
                )}

                {shareLinks[v.id] && (
                  <div className="share-result">
                    <input
                      className="input input-sm"
                      readOnly
                      value={shareLinks[v.id]}
                    />
                    <button
                      onClick={() => copyLink(shareLinks[v.id])}
                      className="btn btn-icon"
                      title="Copy link"
                    >
                      <IconCopy />
                    </button>
                  </div>
                )}

                {shareMsg[v.id] && (
                  <p className="share-sent-msg text-muted">{shareMsg[v.id]}</p>
                )}

                <details className="bulk-add">
                  <summary>Analytics</summary>
                  {videoAnalytics[v.id] ? (
                    <ul className="analytics-list">
                      <li className="analytics-row">
                        <span className="analytics-title">Shares created</span>
                        <span className="analytics-views">{formatNumber(videoAnalytics[v.id].shares)}</span>
                      </li>
                      <li className="analytics-row">
                        <span className="analytics-title">Unique recipients</span>
                        <span className="analytics-views">{formatNumber(videoAnalytics[v.id].uniqueRecipients)}</span>
                      </li>
                      <li className="analytics-row">
                        <span className="analytics-title">Views</span>
                        <span className="analytics-views">{formatNumber(videoAnalytics[v.id].views)}</span>
                      </li>
                      <li className="analytics-row">
                        <span className="analytics-title">Started</span>
                        <span className="analytics-views">{formatNumber(videoAnalytics[v.id].started)}</span>
                      </li>
                      <li className="analytics-row">
                        <span className="analytics-title">Completed</span>
                        <span className="analytics-views">
                          {formatNumber(videoAnalytics[v.id].completed)} ({videoAnalytics[v.id].completionRate}% of starters)
                        </span>
                      </li>
                      <li className="analytics-row">
                        <span className="analytics-title">Avg. furthest progress</span>
                        <span className="analytics-views">{videoAnalytics[v.id].avgProgress}%</span>
                      </li>
                    </ul>
                  ) : (
                    <p className="text-muted mt-4">No active shares for this video yet.</p>
                  )}
                </details>
              </li>
            ))}
          </ul>
          )}
        </div>
        </>
        )}

        {tab === 'activity' && (
        <>
        {/* Activity log */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Activity Log</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            The 100 most recent admin actions.
          </p>
          {audit.length === 0 ? (
            <p className="text-muted">No recorded activity yet.</p>
          ) : (
            <ul className="audit-list">
              {audit.map((a, i) => (
                <li key={i} className="audit-item">
                  <span className="audit-action">{a.action}</span>
                  {a.detail && <span className="audit-detail">{a.detail}</span>}
                  <span className="audit-meta">{a.actor} · {timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </>
        )}

        {tab === 'analytics' && (
        <>
        {/* Analytics */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Analytics</h2>
          {!analytics ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <div className="stat-grid">
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.totalViews)}</span>
                  <span className="stat-label">Total views</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.last30Views)}</span>
                  <span className="stat-label">Views · 30 days</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{analytics.totalWatchHours}h</span>
                  <span className="stat-label">Watch time</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{formatNumber(analytics.videoCount)}</span>
                  <span className="stat-label">Videos</span>
                </div>
              </div>

              {analytics.chart && analytics.chart.length > 0 && (
                <div className="analytics-chart">
                  <div className="chart-heading">Views · last 30 days</div>
                  <div className="chart-bars">
                    {(() => {
                      const max = Math.max(...analytics.chart.map((d) => d.count), 1);
                      return analytics.chart.map((d) => (
                        <span
                          key={d.date}
                          className="chart-bar"
                          style={{ height: `${Math.max(2, Math.round((d.count / max) * 100))}%` }}
                          title={`${d.date}: ${d.count} views`}
                        />
                      ));
                    })()}
                  </div>
                </div>
              )}

              <h3 className="analytics-subhead">Most watched</h3>
              {analytics.topVideos.length === 0 ? (
                <p className="text-muted">No views recorded yet.</p>
              ) : (
                <ul className="analytics-list">
                  {analytics.topVideos.map((v) => (
                    <li key={v.id} className="analytics-row">
                      <span className="analytics-title">{v.title}</span>
                      {v.length > 0 && <span className="analytics-dur">{formatDuration(v.length)}</span>}
                      <span className="analytics-views">{formatNumber(v.views)} views</span>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="analytics-subhead">Per-video analytics</h3>
              {(() => {
                const rows = Object.entries(videoAnalytics)
                  .map(([videoId, a]) => ({ videoId, title: videos.find((v) => v.id === videoId)?.title || 'Untitled', ...a }))
                  .sort((a, b) => b.shares - a.shares);
                if (rows.length === 0) {
                  return <p className="text-muted">No active shares yet — rolls up per-video sharing once links are created.</p>;
                }
                return (
                  <ul className="analytics-list">
                    {rows.map((r) => (
                      <li key={r.videoId} className="analytics-row">
                        <span className="analytics-title">{r.title}</span>
                        <span className="analytics-stats">
                          {formatNumber(r.shares)} share{r.shares === 1 ? '' : 's'} · {formatNumber(r.uniqueRecipients)} recipient{r.uniqueRecipients === 1 ? '' : 's'} · {formatNumber(r.views)} view{r.views === 1 ? '' : 's'} · {formatNumber(r.started)} started · {formatNumber(r.completed)} completed ({r.completionRate}%) · {r.avgProgress}% avg progress
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </>
          )}
        </div>
        </>
        )}

      </div>
    </AppShell>
  );
}
