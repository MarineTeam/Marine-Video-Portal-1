import { useUser } from '@auth0/nextjs-auth0/client';
import { getSession } from '../lib/auth0';
import { useEffect, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import NotifyButton from '../components/NotifyButton';
import RolesSection from '../components/RolesSection';
import { IconTrash, IconCopy, IconGrip, IconPencil, IconSearch, IconCheck, IconX } from '../components/icons';
import { applyTheme, DEFAULT_THEME, PRESETS, isValidHex } from '../lib/theme';
import { MAX_SITE_NAME_LENGTH, cleanSiteName } from '../lib/branding';
import { getAccess } from '../lib/roles';
import { mailEnabled as mailConfigured } from '../lib/mail';
import { isGeoAllowed } from '../lib/geo';
import { withMonitorPage } from '../lib/monitor';
import { resetMonitorCalls } from '../lib/monitorClient';
import { formatChaptersText, parseChapters } from '../lib/videoMeta';
import { sameChapters } from '../lib/aiChapters';

// Server-side gate: only staff (anyone holding at least one capability) can
// load the admin page at all. The per-route 403s remain as defense in depth,
// but this stops a logged-in viewer from ever receiving the admin UI shell.
//
// The caller's capabilities are passed to the component so it shows only the
// tabs and sections they can use, and never fires a request guaranteed to
// 403. That is presentation only — every route independently enforces its
// capability, so someone who forces a hidden section open still gets a 403.
async function getServerSidePropsInner({ req, res }) {
  const session = await getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/api/auth/login?returnTo=/admin', permanent: false } };
  }
  const access = await getAccess(session.user?.email);
  if (!access.staff) {
    return { redirect: { destination: '/', permanent: false } };
  }
  // Admin geo whitelist (off by default) — a bypass-listed admin (see
  // ADMIN_GEO_BYPASS_EMAILS in lib/geo.js) always passes this regardless.
  if (!(await isGeoAllowed(req, session.user.email.toLowerCase(), true))) {
    return { redirect: { destination: '/', permanent: false } };
  }
  // Plain data, not anything imported from lib/roles.js: that module is
  // server-only (it reaches lib/redis.js, and through it Node's async_hooks),
  // so referencing it in the component below would pull that whole graph into
  // the client bundle and fail the build. Next strips imports used only by
  // getServerSideProps — keep them that way.
  //
  // mailEnabled rides along because the share forms need it and the route
  // that used to supply it (/api/admin/settings) is settings:manage only.
  return {
    props: {
      capabilities: access.capabilities,
      mailOn: mailConfigured(),
    },
  };
}

export const getServerSideProps = withMonitorPage(getServerSidePropsInner);

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

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time; a ms epoch put
// through toISOString() would render as UTC and silently shift the admin's
// entry by their offset every time the field round-trips.
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return '';
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : '';
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function repeatSummary(repeat) {
  if (!repeat) return undefined;
  return `${repeat.days.map((d) => WEEKDAY_NAMES[d]).join(', ')} ${repeat.start}–${repeat.end} (${repeat.timeZone})`;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// One video's schedule: the publish/expiry dates, an optional weekly repeat
// and optional per-group windows (lib/schedule.js). Edited as a draft and
// saved with one button, because the three parts are one entry.
//
// Dates leave here as ms epochs, converted in the browser: the server has no
// idea what time zone the admin typed in, so sending the datetime-local text
// would have it read in the server's zone instead.
//
// `groups` is empty for an admin without groups:manage. Their existing group
// windows are still sent back unchanged, so saving the dates never drops a
// window they cannot see to edit.
function ScheduleEditor({ video, groups, onSave }) {
  const schedule = video.schedule || null;
  const [publishAt, setPublishAt] = useState(toLocalInput(schedule?.publishAt));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(schedule?.expiresAt));
  const existingRepeat = schedule?.repeat || null;
  const [repeatOn, setRepeatOn] = useState(Boolean(existingRepeat));
  const [repeatDays, setRepeatDays] = useState(existingRepeat?.days || [0]);
  const [repeatStart, setRepeatStart] = useState(existingRepeat?.start || '09:00');
  const [repeatEnd, setRepeatEnd] = useState(existingRepeat?.end || '13:00');
  const [repeatZone] = useState(existingRepeat?.timeZone || browserTimeZone());
  const [groupRows, setGroupRows] = useState(() =>
    Object.entries(schedule?.groups || {}).map(([groupId, w]) => ({
      groupId,
      publishAt: toLocalInput(w?.publishAt),
      expiresAt: toLocalInput(w?.expiresAt),
    }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const knownGroups = groups || [];
  const groupName = (id) => knownGroups.find((g) => g.id === id)?.name || 'Other group';
  const toggleDay = (d) =>
    setRepeatDays((days) => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort()));
  const patchRow = (index, patch) =>
    setGroupRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const unusedGroups = knownGroups.filter((g) => !groupRows.some((r) => r.groupId === g.id));

  async function save(clear) {
    setBusy(true);
    setError('');
    setSaved(false);
    const groupWindows = {};
    for (const row of groupRows) {
      if (!row.groupId || (!row.publishAt && !row.expiresAt)) continue;
      groupWindows[row.groupId] = {
        publishAt: fromLocalInput(row.publishAt) || null,
        expiresAt: fromLocalInput(row.expiresAt) || null,
      };
    }
    const problem = await onSave({
      publishAt: clear ? '' : fromLocalInput(publishAt),
      expiresAt: clear ? '' : fromLocalInput(expiresAt),
      repeat:
        clear || !repeatOn
          ? null
          : { days: repeatDays, start: repeatStart, end: repeatEnd, timeZone: repeatZone },
      groups: clear ? null : groupWindows,
    });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setSaved(true);
    if (clear) {
      setPublishAt('');
      setExpiresAt('');
      setRepeatOn(false);
      setGroupRows([]);
    }
  }

  return (
    <div className="schedule-editor">
      <p className="text-muted" style={{ margin: '8px 0' }}>
        Leave both dates blank to keep this video visible with no time limit. Viewers can&rsquo;t
        see or open it outside the window; admins and managers always can.
      </p>
      <div className="schedule-fields">
        <label>
          <span className="collection-label">Publish at</span>
          <input
            type="datetime-local"
            className="input input-sm"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
          />
        </label>
        <label>
          <span className="collection-label">Expires at</span>
          <input
            type="datetime-local"
            className="input input-sm"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
      </div>

      <div className="schedule-repeat">
        <label className="schedule-check">
          <input type="checkbox" checked={repeatOn} onChange={(e) => setRepeatOn(e.target.checked)} />
          <span>Only at set times each week</span>
        </label>
        {repeatOn ? (
          <>
            <div className="schedule-days" role="group" aria-label="Days">
              {WEEKDAY_NAMES.map((name, d) => (
                <label key={name} className="schedule-check">
                  <input type="checkbox" checked={repeatDays.includes(d)} onChange={() => toggleDay(d)} />
                  <span>{name}</span>
                </label>
              ))}
            </div>
            <div className="schedule-times">
              <input
                type="time"
                className="input input-sm"
                value={repeatStart}
                onChange={(e) => setRepeatStart(e.target.value)}
                aria-label="From"
              />
              <span className="text-muted">to</span>
              <input
                type="time"
                className="input input-sm"
                value={repeatEnd}
                onChange={(e) => setRepeatEnd(e.target.value)}
                aria-label="Until"
              />
              <span className="text-muted">{repeatZone}</span>
            </div>
            <p className="text-muted schedule-note">
              Visible to viewers only during these hours, within the dates above. An end time before
              the start runs past midnight. Group windows below are not limited by this.
            </p>
          </>
        ) : null}
      </div>

      {knownGroups.length > 0 || groupRows.length > 0 ? (
        <div className="schedule-groups">
          <p className="text-muted schedule-note">
            Earlier or longer for a group — members of these groups can also watch during their own
            window. This only ever adds time; it never hides the video from a group (the group&rsquo;s
            own video list does that).
          </p>
          {groupRows.map((row, index) => (
            <div key={row.groupId || `new-${index}`} className="schedule-group-row">
              <select
                className="input input-sm"
                value={row.groupId}
                onChange={(e) => patchRow(index, { groupId: e.target.value })}
                aria-label="Group"
                disabled={knownGroups.length === 0}
              >
                <option value="">Choose a group…</option>
                {row.groupId && !knownGroups.some((g) => g.id === row.groupId) ? (
                  <option value={row.groupId}>{groupName(row.groupId)}</option>
                ) : null}
                {knownGroups
                  .filter((g) => g.id === row.groupId || !groupRows.some((r) => r.groupId === g.id))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
              <input
                type="datetime-local"
                className="input input-sm"
                value={row.publishAt}
                onChange={(e) => patchRow(index, { publishAt: e.target.value })}
                aria-label="Group publish at"
                title="Visible to this group from"
              />
              <input
                type="datetime-local"
                className="input input-sm"
                value={row.expiresAt}
                onChange={(e) => patchRow(index, { expiresAt: e.target.value })}
                aria-label="Group expires at"
                title="Hidden from this group again at"
              />
              <button
                type="button"
                className="btn btn-sm"
                aria-label="Remove group window"
                onClick={() => setGroupRows((rows) => rows.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          ))}
          {unusedGroups.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setGroupRows((rows) => [...rows, { groupId: '', publishAt: '', expiresAt: '' }])
              }
            >
              Add a group window
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="schedule-error">{error}</p> : null}
      <div className="schedule-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save(false)}>
          Save schedule
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save(true)}>
          Clear
        </button>
        {saved ? <span className="text-muted">Saved</span> : null}
      </div>
    </div>
  );
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

// Draws the chosen image, centre-cropped to a square, at one size, and returns
// the PNG as base64. The resize happens HERE, in the browser, so the server
// needs no image library — and it re-checks every result anyway
// (lib/appIcon.js), so nothing about this function is trusted.
function renderIconPng(image, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2;
  ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image'));
    };
    image.src = url;
  });
}

function AppIconSetting() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Changes after a save or reset, so the preview is refetched.
  const [bust, setBust] = useState(0);

  async function send(method, body) {
    const res = await fetch('/api/admin/app-icon', {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed (status ${res.status})`);
    return data;
  }

  async function choose(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg('');
    setBusy(true);
    try {
      const image = await loadImage(file);
      if (Math.min(image.naturalWidth, image.naturalHeight) < 512) {
        throw new Error('Choose an image at least 512 pixels on its shorter side');
      }
      const icons = {};
      for (const size of [180, 192, 512]) icons[size] = renderIconPng(image, size);
      await send('PUT', { icons });
      setMsg('Saved. New installs use it now; installed apps pick it up when the browser next checks.');
      setBust(Date.now());
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setMsg('');
    setBusy(true);
    try {
      await send('DELETE');
      setMsg('Back to the built-in icon.');
      setBust(Date.now());
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-block">
      <span className="collection-label">App icon</span>
      <p className="text-muted" style={{ margin: '4px 0 8px' }}>
        The picture on a phone&rsquo;s home screen when the portal is installed, and the podcast
        cover. Any image works &mdash; it is cropped to a square from the centre. PNG output only.
      </p>
      <div className="admin-row">
        <img
          src={`/api/app-icon/192?preview=${bust}`}
          alt="Current app icon"
          width={48}
          height={48}
          className="app-icon-preview"
        />
        <label className="btn btn-primary btn-sm" aria-disabled={busy}>
          {busy ? 'Working…' : 'Choose image'}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={choose} />
        </label>
        <button onClick={reset} className="btn btn-outline btn-sm" disabled={busy}>
          Reset to default
        </button>
        {msg && <span className="text-muted">{msg}</span>}
      </div>
    </div>
  );
}

// Which capability opens each tab. Access holds three sections — access
// requests, groups and roles — so any of their capabilities opens it.
const TABS = [
  { id: 'videos', label: 'Videos', caps: ['videos:manage'] },
  { id: 'viewers', label: 'Viewers', caps: ['viewers:manage'] },
  { id: 'access', label: 'Access', caps: ['viewers:manage', 'groups:manage', 'roles:manage'] },
  { id: 'shares', label: 'Shares', caps: ['shares:manage'] },
  { id: 'settings', label: 'Settings', caps: ['settings:manage'] },
  { id: 'activity', label: 'Activity', caps: ['audit:read'] },
  { id: 'analytics', label: 'Analytics', caps: ['analytics:read'] },
];

export default function Admin({ capabilities = [], mailOn = false }) {
  const { user, isLoading } = useUser();
  const can = (cap) => capabilities.includes(cap);
  const visibleTabs = TABS.filter((t) => t.caps.some((c) => capabilities.includes(c)));
  const [videos, setVideos] = useState([]);
  const [emails, setEmails] = useState({});
  const [shareLinks, setShareLinks] = useState({});
  const [activeShares, setActiveShares] = useState([]);
  // When the share list was loaded. "Expired" is judged against this rather
  // than Date.now() in render, which would make a badge flip on whatever
  // re-render happened to cross the expiry (React's purity rule).
  const [sharesLoadedAt, setSharesLoadedAt] = useState(() => Date.now());
  const showShares = (list) => {
    setActiveShares(list);
    setSharesLoadedAt(Date.now());
  };
  const [viewers, setViewers] = useState([]);
  const [newViewerEmail, setNewViewerEmail] = useState('');
  const [tagDrafts, setTagDrafts] = useState({});
  const [tagBusy, setTagBusy] = useState({});
  const [bulkTagPick, setBulkTagPick] = useState('');
  const [bulkCollectionPick, setBulkCollectionPick] = useState('');
  const [videoCount, setVideoCount] = useState(2);
  const [expiresHours, setExpiresHours] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  // The first tab this person can use. Someone holding only comments:manage
  // has no tab here at all — their capability is used on the watch page.
  const [tab, setTab] = useState(() => visibleTabs[0]?.id || 'none');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [themeSaved, setThemeSaved] = useState(false);
  const [metaDrafts, setMetaDrafts] = useState({});
  const [metaBusy, setMetaBusy] = useState({});
  const [transcribeStatus, setTranscribeStatus] = useState({}); // videoId -> message
  // Opt-in and unticked by default: chapter suggestions ride along with the
  // same transcription job at no extra charge, but a video whose chapters are
  // already typed has no use for them. Nothing they produce is ever saved.
  const [wantChapters, setWantChapters] = useState({}); // videoId -> boolean
  const [suggestStatus, setSuggestStatus] = useState({}); // videoId -> message
  const [metaIgnored, setMetaIgnored] = useState({});
  const [publicBusy, setPublicBusy] = useState({});
  const [siteNameDraft, setSiteNameDraft] = useState('');
  const [siteNameSaved, setSiteNameSaved] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const [uploadErrorMsg, setUploadErrorMsg] = useState('');
  // Groups the next upload is granted to, and any the server could not grant.
  const [uploadGroups, setUploadGroups] = useState([]);
  const [uploadGrantMsg, setUploadGrantMsg] = useState('');
  const [bulkEmails, setBulkEmails] = useState('');
  const [videoQuery, setVideoQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [dragOverId, setDragOverId] = useState(null);
  const [audit, setAudit] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [collections, setCollections] = useState([]);
  // Access tab: viewer groups. Roles keep their own state in RolesSection.
  const [groups, setGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupMemberDrafts, setGroupMemberDrafts] = useState({});
  const [groupError, setGroupError] = useState(null);
  const [groupBusy, setGroupBusy] = useState({});
  const [accessRequests, setAccessRequests] = useState([]);
  const [requestBusy, setRequestBusy] = useState({});
  const [newCollection, setNewCollection] = useState('');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [mailEnabled, setMailEnabled] = useState(mailOn);
  const [queryMonitorEnabled, setQueryMonitorEnabled] = useState(false);
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
  const [privateLists, setPrivateLists] = useState({});
  const [privateListInput, setPrivateListInput] = useState({});
  const [privateListNotify, setPrivateListNotify] = useState({});
  const [privateListMsg, setPrivateListMsg] = useState({});
  const [privateListBusy, setPrivateListBusy] = useState({});
  const [privateListTagPick, setPrivateListTagPick] = useState({});
  const [shareTagPick, setShareTagPick] = useState({});
  const [videoOpsSelected, setVideoOpsSelected] = useState({});
  const [videoOpsCollection, setVideoOpsCollection] = useState('');
  const [videoOpsMsg, setVideoOpsMsg] = useState('');
  const [videoOpsActing, setVideoOpsActing] = useState(false);
  const [geoViewerEnabled, setGeoViewerEnabled] = useState(false);
  const [geoViewerCountries, setGeoViewerCountries] = useState([]);
  const [geoAdminEnabled, setGeoAdminEnabled] = useState(false);
  const [geoAdminCountries, setGeoAdminCountries] = useState([]);
  const [geoSaved, setGeoSaved] = useState(false);
  const [verification, setVerification] = useState(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  // True when the library is larger than the admin list can read in full.
  const [videosTruncated, setVideosTruncated] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState('');
  const fileInputRef = useRef(null);
  const uploadRef = useRef(null);
  const uploadVideoIdRef = useRef(null);
  const dragIdRef = useRef(null);

  async function fetchVideos() {
    const r = await fetch('/api/admin/videos');
    // Only a 403 is a permissions answer; anything else is the library (or
    // bunny.net) failing, and calling that "not an admin" sends people to
    // check their role instead of retrying.
    if (r.status === 403) throw new Error("Your roles don't include managing videos");
    if (!r.ok) throw new Error('Could not load the video library — try again in a moment');
    setVideosTruncated(r.headers.get('X-Library-Truncated') === '1');
    setVideos(await r.json());
  }

  // Each load is asked for only by someone whose capabilities allow it. With
  // custom roles a staff member may hold any subset, and a 403 body fed into
  // a list setter would crash the page (viewers.flatMap on { error }).
  useEffect(() => {
    if (!user) return;
    const has = (cap) => capabilities.includes(cap);

    if (has('videos:manage')) fetchVideos().catch((e) => setError(e.message));
    if (has('viewers:manage')) {
      fetch('/api/admin/viewers').then((r) => (r.ok ? r.json() : [])).then(setViewers).catch(() => {});
    }
    if (has('shares:manage')) {
      fetch('/api/admin/shares').then((r) => (r.ok ? r.json() : [])).then(showShares).catch(() => {});
    }
    if (has('videos:manage')) {
      fetch('/api/admin/collections').then((r) => (r.ok ? r.json() : [])).then(setCollections).catch(() => {});
    }
    if (!has('settings:manage')) return;
    fetch('/api/admin/settings').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      setVideoCount(d.count);
      setMailEnabled(Boolean(d.mailEnabled));
      setQueryMonitorEnabled(Boolean(d.queryMonitorEnabled));
    }).catch(() => {});
    fetch('/api/theme')
      .then((r) => r.json())
      .then(({ siteName, ...palette }) => {
        setTheme(palette);
        setSiteNameDraft(siteName || '');
      })
      .catch(() => {});
    fetch('/api/admin/watermark')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setWatermarkGlobal(Boolean(d.global)); setWatermarkExempt(d.exempt || []); } })
      .catch(() => {});
    fetch('/api/admin/verification')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setVerification(d))
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
  }, [user, capabilities]);

  // Load the per-video analytics rollup the first time the Videos or Analytics
  // tab is opened (and refresh on revisit) — same lazy pattern as Activity/Analytics.
  useEffect(() => {
    if (!user || (tab !== 'videos' && tab !== 'analytics')) return;
    fetch('/api/admin/video-analytics').then((r) => (r.ok ? r.json() : {})).then(setVideoAnalytics).catch(() => {});
  }, [user, tab]);

  // Same lazy load for every video's private list, keyed on the Videos tab.
  useEffect(() => {
    if (!user || tab !== 'videos') return;
    fetch('/api/admin/private-list').then((r) => (r.ok ? r.json() : {})).then(setPrivateLists).catch(() => {});
    // The upload form's "also visible to groups" picker needs the group
    // names here too, not only on the Access tab. A caller without
    // groups:manage gets a 403 and simply sees no picker.
    fetch('/api/admin/groups').then((r) => (r.ok ? r.json() : [])).then(setGroups).catch(() => {});
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

  // Requests, groups and roles load when the Access tab is opened — same lazy
  // pattern. Each is skipped by anyone whose capabilities would get a 403.
  useEffect(() => {
    if (!user || tab !== 'access') return;
    const has = (cap) => capabilities.includes(cap);
    if (has('groups:manage')) {
      fetch('/api/admin/groups').then((r) => (r.ok ? r.json() : [])).then(setGroups).catch(() => {});
    }
    if (has('viewers:manage')) {
      fetch('/api/admin/access-requests')
        .then((r) => (r.ok ? r.json() : []))
        .then(setAccessRequests)
        .catch(() => {});
    }
  }, [user, tab, capabilities]);

  // Tabs are pure React state, not route changes, so the Query Monitor panel
  // has no way to tell that the user moved to a new screen — left alone it
  // grows forever on the tabs that lazily fetch and looks frozen on the ones
  // whose data was loaded once upfront. Starting a fresh view here makes it
  // report what the current tab actually cost. No-op when the monitor is off.
  useEffect(() => {
    resetMonitorCalls();
  }, [tab]);

  // Live-preview a palette change across the whole page as the admin edits.
  function previewTheme(next) {
    setTheme(next);
    setThemeSaved(false);
    applyTheme(next);
  }

  function setAccent(which, value) {
    previewTheme({ ...theme, [which]: value });
  }

  async function saveSiteName() {
    const name = cleanSiteName(siteNameDraft);
    const res = await fetch('/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Failed to save the name'); return; }
    // The server resolves a blank name back to the default, so echo whatever
    // it actually stored rather than the empty box.
    setSiteNameDraft(data.siteName || '');
    setSiteNameSaved(true);
    setTimeout(() => setSiteNameSaved(false), 1500);
    // The header reads the name from context, seeded by the /api/theme fetch
    // in _app — reload so the rename is visible everywhere at once.
    window.location.reload();
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
        body: JSON.stringify({
          title: uploadTitle.trim() || uploadFile.name,
          // Only sent when something is ticked, so an ordinary upload is the
          // exact request it always was.
          ...(uploadGroups.length ? { groupIds: uploadGroups } : {}),
        }),
      });
      meta = await res.json();
      if (!res.ok) throw new Error(meta.error || `Create-video failed (HTTP ${res.status})`);
      if (!meta.videoId) throw new Error('Server did not return a video id');
      // The video exists and the bytes are about to go; a group that could
      // not be granted is said out loud rather than left for a viewer to
      // discover by not seeing the video.
      const failedGroups = meta.groups?.failed || [];
      setUploadGrantMsg(
        failedGroups.length
          ? `Could not add this video to ${failedGroups
              .map((id) => groups.find((g) => g.id === id)?.name || id)
              .join(', ')} — tick it on the Groups tab.`
          : ''
      );
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
        setUploadGroups([]);
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

  // Giving someone a role also approves them, so the Viewers list goes stale.
  function reloadViewers() {
    if (!can('viewers:manage')) return;
    fetch('/api/admin/viewers').then((r) => (r.ok ? r.json() : null)).then((l) => l && setViewers(l)).catch(() => {});
  }

  async function decideAccessRequest(email, status) {
    setRequestBusy((prev) => ({ ...prev, [email]: true }));
    try {
      const res = await fetch('/api/admin/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, status }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to update request'); return; }
      setAccessRequests((prev) => prev.map((r) => (r.email === email ? data.request : r)));
      // Approving adds them to the viewer list, so that tab is now stale.
      if (status === 'approved') {
        fetch('/api/admin/viewers')
          .then((rr) => (rr.ok ? rr.json() : null))
          .then((l) => l && setViewers(l))
          .catch(() => {});
      }
    } finally {
      setRequestBusy((prev) => ({ ...prev, [email]: false }));
    }
  }

  async function dismissAccessRequest(email) {
    const res = await fetch('/api/admin/access-requests', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) { alert('Failed to remove request'); return; }
    setAccessRequests((prev) => prev.filter((r) => r.email !== email));
  }

  async function createGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const res = await fetch('/api/admin/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { setGroupError(data.error || 'Failed to create group'); return; }
    setGroupError(null);
    setNewGroupName('');
    setGroups((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function deleteGroup(groupId, name) {
    if (!confirm(`Delete the group "${name}"? Its members go back to seeing the whole library.`)) return;
    const res = await fetch('/api/admin/groups', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    if (!res.ok) { setGroupError('Failed to delete group'); return; }
    setGroupError(null);
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  }

  async function addGroupMembers(groupId) {
    const text = (groupMemberDrafts[groupId] || '').trim();
    if (!text) return;
    const res = await fetch('/api/admin/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, emails: text }),
    });
    const data = await res.json();
    if (!res.ok) { setGroupError(data.error || 'Failed to add members'); return; }
    // Refusals are shown, never swallowed. An address that is not an approved
    // viewer is simply absent otherwise, and an admin can believe somebody is
    // in a group for months.
    const notes = [];
    if (data.unknown?.length) notes.push(`not approved viewers: ${data.unknown.join(', ')}`);
    if (data.invalid?.length) notes.push(`not valid addresses: ${data.invalid.join(', ')}`);
    setGroupError(notes.length ? notes.join(' · ') : null);
    setGroupMemberDrafts((prev) => ({ ...prev, [groupId]: '' }));
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? { ...g, members: [...new Set([...g.members, ...(data.added || [])])].sort() }
          : g
      )
    );
  }

  async function removeGroupMember(groupId, email) {
    const res = await fetch('/api/admin/groups', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, email }),
    });
    if (!res.ok) { setGroupError('Failed to remove member'); return; }
    setGroupError(null);
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, members: g.members.filter((m) => m !== email) } : g))
    );
  }

  // Grants are saved as whole arrays, so a toggle sends the group's next
  // full state rather than a diff the server would have to merge.
  async function saveGroupGrants(groupId, patch) {
    setGroupBusy((prev) => ({ ...prev, [groupId]: true }));
    try {
      const res = await fetch('/api/admin/groups', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) { setGroupError(data.error || 'Failed to update group'); return; }
      setGroupError(null);
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, ...data } : g)));
    } finally {
      setGroupBusy((prev) => ({ ...prev, [groupId]: false }));
    }
  }

  function toggleGroupGrant(group, field, id) {
    const current = group[field] || [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    return saveGroupGrants(group.id, { [field]: next });
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

  async function saveViewerTags(email) {
    const tags = (tagDrafts[email] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    setTagBusy((prev) => ({ ...prev, [email]: true }));
    try {
      const res = await fetch('/api/admin/viewers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, tags }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'Failed to save tags'); return; }
      setViewers((prev) => prev.map((v) => (v.email === email ? { ...v, tags: data.tags } : v)));
    } finally {
      setTagBusy((prev) => ({ ...prev, [email]: false }));
    }
  }

  // Append every viewer carrying the picked tag into the bulk-share recipient
  // textarea (skipping ones already present), so a group can be targeted in
  // one click instead of pasting each address.
  function addTagToBulkRecipients() {
    if (!bulkTagPick) return;
    const already = new Set(
      bulkRecipients.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    );
    const toAdd = viewers
      .filter((v) => (v.tags || []).includes(bulkTagPick) && !already.has(v.email))
      .map((v) => v.email);
    if (toAdd.length === 0) return;
    setBulkRecipients((prev) => (prev.trim() ? `${prev.trim()}\n${toAdd.join('\n')}` : toAdd.join('\n')));
  }

  // Append every viewer carrying the picked tag into a video's private-list
  // textarea (skipping ones already present), mirroring addTagToBulkRecipients
  // so a group can be added to the standing list in one click.
  function addTagToPrivateList(video) {
    const tag = privateListTagPick[video.id];
    if (!tag) return;
    const already = new Set(
      (privateListInput[video.id] || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    );
    const toAdd = viewers
      .filter((v) => (v.tags || []).includes(tag) && !already.has(v.email))
      .map((v) => v.email);
    if (toAdd.length === 0) return;
    setPrivateListInput((prev) => {
      const existing = (prev[video.id] || '').trim();
      return { ...prev, [video.id]: existing ? `${existing}\n${toAdd.join('\n')}` : toAdd.join('\n') };
    });
  }

  // Same tag-picker pattern as Bulk Share and Private list, but for the
  // per-video "Create link" recipient field.
  function addTagToShare(video) {
    const tag = shareTagPick[video.id];
    if (!tag) return;
    const already = new Set(
      (emails[video.id] || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    );
    const toAdd = viewers
      .filter((v) => (v.tags || []).includes(tag) && !already.has(v.email))
      .map((v) => v.email);
    if (toAdd.length === 0) return;
    setEmails((prev) => {
      const existing = (prev[video.id] || '').trim();
      return { ...prev, [video.id]: existing ? `${existing}\n${toAdd.join('\n')}` : toAdd.join('\n') };
    });
  }

  // Check every video belonging to the picked collection into the bulk-share
  // video picklist (leaving existing selections and the rest of the flow
  // untouched — Create Links still runs the same per-video/recipient share
  // creation as manual picks).
  function addCollectionToBulkVideos() {
    if (!bulkCollectionPick) return;
    const toAdd = videos.filter((v) => v.collectionId === bulkCollectionPick).map((v) => v.id);
    if (toAdd.length === 0) return;
    setBulkSelected((prev) => {
      const next = { ...prev };
      for (const id of toAdd) next[id] = true;
      return next;
    });
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

  async function toggleVideoPublic(v, isPublic) {
    if (isPublic && !confirm(
      `Make "${v.title || 'this video'}" viewable by anyone with the link, without signing in?\n\n` +
      'It stays out of the library and out of search — only people you send the link to will find it.'
    )) return;
    setPublicBusy((prev) => ({ ...prev, [v.id]: true }));
    try {
      const res = await fetch('/api/admin/public-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: v.id, isPublic }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to update'); return; }
      setVideos((prev) => prev.map((x) => (x.id === v.id ? { ...x, isPublic: data.isPublic } : x)));
    } finally {
      setPublicBusy((prev) => ({ ...prev, [v.id]: false }));
    }
  }

  // Transcription. TWO steps, not one, because bunny's Transcribe AI is
  // asynchronous: queueing returns immediately and the captions land minutes
  // later. Hiding that behind a poller would hide the timing and the cost
  // from the person who pressed the button.
  async function transcribeVideo(videoId, ingest) {
    setTranscribeStatus((prev) => ({ ...prev, [videoId]: ingest ? 'Fetching…' : 'Queueing…' }));
    try {
      const res = await fetch('/api/admin/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          ...(ingest ? { ingest: true } : { chapters: wantChapters[videoId] === true }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTranscribeStatus((prev) => ({ ...prev, [videoId]: data.error || 'That did not work.' }));
        return;
      }
      const message = data.queued
        ? data.chapters
          ? 'Queued with chapter suggestions — a few minutes, then Fetch captions and Suggest chapters.'
          : 'Queued — bunny takes a few minutes, then press Fetch captions.'
        : data.ready
          ? `Fetched ${data.cues} lines (${data.language}).`
          : 'Not ready yet — give it a minute, then press Fetch captions.';
      setTranscribeStatus((prev) => ({ ...prev, [videoId]: message }));
    } catch (e) {
      setTranscribeStatus((prev) => ({ ...prev, [videoId]: 'That did not work.' }));
    }
  }

  // Loads bunny's generated chapters INTO THE TEXTAREA. This is the accept
  // step and deliberately only half of one: the suggestions sit in the box
  // until the admin presses "Save chapters & notes", so what gets stored is
  // still something a person chose. Replacing text they typed asks first — the
  // AI is not allowed to overwrite someone's work on a single click.
  async function suggestChapters(v) {
    setSuggestStatus((prev) => ({ ...prev, [v.id]: 'Reading…' }));
    try {
      const res = await fetch('/api/admin/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: v.id, suggestions: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSuggestStatus((prev) => ({ ...prev, [v.id]: data.error || 'That did not work.' }));
        return;
      }
      const proposed = data.chapters || [];
      const skipped = data.ignored || [];
      if (proposed.length === 0) {
        setSuggestStatus((prev) => ({
          ...prev,
          [v.id]: skipped.length
            ? `bunny returned ${skipped.length} chapter(s) that could not be read: ${skipped.join(' · ')}`
            : 'bunny has not generated chapters for this video. Transcribe again with the box ticked.',
        }));
        return;
      }
      const draft = metaDraft(v, 'chaptersText');
      const current = parseChapters(draft).chapters;
      if (sameChapters(current, proposed)) {
        setSuggestStatus((prev) => ({
          ...prev,
          [v.id]: 'The suggestions match what is already here.',
        }));
        return;
      }
      if (
        draft.trim() &&
        !window.confirm(
          `Replace the ${current.length} chapter(s) in the box with ${proposed.length} suggested one(s)? Nothing is saved until you press Save.`
        )
      ) {
        setSuggestStatus((prev) => ({ ...prev, [v.id]: '' }));
        return;
      }
      setMetaDraft(v.id, 'chaptersText', formatChaptersText(proposed));
      setSuggestStatus((prev) => ({
        ...prev,
        [v.id]: `Loaded ${proposed.length} suggestion(s)${
          skipped.length ? `, skipped ${skipped.length}` : ''
        } — edit, then press Save chapters & notes.`,
      }));
    } catch (e) {
      setSuggestStatus((prev) => ({ ...prev, [v.id]: 'That did not work.' }));
    }
  }

  function metaDraft(v, field) {
    const draft = metaDrafts[v.id];
    if (draft && draft[field] !== undefined) return draft[field];
    return field === 'chaptersText' ? v.chaptersText || '' : v.notes || '';
  }

  function setMetaDraft(videoId, field, value) {
    setMetaDrafts((prev) => ({ ...prev, [videoId]: { ...prev[videoId], [field]: value } }));
  }

  async function saveVideoMeta(v) {
    setMetaBusy((prev) => ({ ...prev, [v.id]: true }));
    try {
      const res = await fetch('/api/admin/videos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: v.id,
          notes: metaDraft(v, 'notes'),
          chaptersText: metaDraft(v, 'chaptersText'),
        }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to save chapters and notes'); return; }
      setVideos((prev) =>
        prev.map((x) =>
          x.id === v.id
            ? { ...x, notes: data.notes, chapters: data.chapters, chaptersText: data.chaptersText }
            : x
        )
      );
      // Echo back what the server actually stored, so a reformatted timestamp
      // or a dropped line is visible in the box rather than only on reload.
      setMetaDrafts((prev) => ({
        ...prev,
        [v.id]: { notes: data.notes, chaptersText: data.chaptersText },
      }));
      setMetaIgnored((prev) => ({ ...prev, [v.id]: data.ignored || [] }));
    } finally {
      setMetaBusy((prev) => ({ ...prev, [v.id]: false }));
    }
  }

  // The whole entry goes up together — dates, weekly repeat and group
  // windows — so clearing one field and saving never looks like "leave it as
  // it was". Empty dates and a null repeat/groups clear them server-side.
  // Returns an error message for the editor to show, or null.
  async function saveVideoSchedule(v, schedule) {
    const res = await fetch('/api/admin/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.id, ...schedule }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data.error || 'Failed to save schedule';
    setVideos((prev) =>
      prev.map((x) =>
        x.id === v.id ? { ...x, schedule: data.schedule, scheduleState: data.scheduleState } : x
      )
    );
    return null;
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
    showShares(await r.json());
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
    const emailList = [...new Set(
      (emails[video.id] || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    )];
    if (!emailList.length) return alert('Enter at least one recipient email');
    const hours = parseInt(expiresHours[video.id]) || 72;
    const notify = mailEnabled && Boolean(notifyShare[video.id]);
    const res = await fetch('/api/admin/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos: [{ id: video.id, title: video.title }],
        emails: emailList,
        expiresInHours: hours,
        notify,
        watermarkMode: shareWatermark[video.id] || 'default',
      }),
    });
    const data = await res.json();
    const watchUrls = (data.links || []).map((l) => l.watchUrl).filter(Boolean);
    setShareLinks((prev) => ({ ...prev, [video.id]: watchUrls }));
    const emailedCount = data.emailedTo?.length || 0;
    setShareMsg((prev) => ({
      ...prev,
      [video.id]: notify
        ? (emailedCount === emailList.length
            ? `Link${emailList.length > 1 ? 's' : ''} emailed to ${emailList.length} recipient${emailList.length > 1 ? 's' : ''}`
            : `Link${emailList.length > 1 ? 's' : ''} created — emailed ${emailedCount}/${emailList.length}`)
        : '',
    }));
    refreshShares();
  }

  async function refreshPrivateList() {
    const r = await fetch('/api/admin/private-list');
    setPrivateLists(r.ok ? await r.json() : {});
  }

  // Private list add: diffs against who's already active for this video —
  // the API only creates shares (and emails) for the genuinely new ones.
  async function addToPrivateList(video) {
    const emails = [...new Set(
      (privateListInput[video.id] || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    )];
    if (!emails.length) return alert('Enter at least one email');
    const notify = mailEnabled && privateListNotify[video.id] !== false;

    setPrivateListBusy((prev) => ({ ...prev, [video.id]: true }));
    try {
      const res = await fetch('/api/admin/private-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: video.id, title: video.title, emails, notify }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'Failed to add to private list'); return; }

      const parts = [];
      if (data.added?.length) {
        parts.push(
          `Added ${data.added.length}${notify ? ` — emailed ${data.emailedTo.length}/${data.added.length}` : ''}`
        );
      }
      if (data.alreadyListed?.length) parts.push(`${data.alreadyListed.length} already had access`);
      setPrivateListMsg((prev) => ({ ...prev, [video.id]: parts.join('; ') || 'No new recipients' }));
      setPrivateListInput((prev) => ({ ...prev, [video.id]: '' }));
      refreshPrivateList();
    } finally {
      setPrivateListBusy((prev) => ({ ...prev, [video.id]: false }));
    }
  }

  // Removing revokes the underlying share immediately; re-adding this email
  // later is a fresh invite (a new share, new notification).
  async function removeFromPrivateList(video, email) {
    setPrivateListBusy((prev) => ({ ...prev, [video.id]: true }));
    try {
      const res = await fetch('/api/admin/private-list', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: video.id, email }),
      });
      if (res.ok) {
        setPrivateLists((prev) => ({
          ...prev,
          [video.id]: (prev[video.id] || []).filter((m) => m.email !== email),
        }));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to remove');
      }
    } finally {
      setPrivateListBusy((prev) => ({ ...prev, [video.id]: false }));
    }
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
      setBulkCollectionPick('');
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

  async function setVerificationEnforcement(enabled) {
    // Turning it ON requires an explicit confirmation naming the number of
    // viewers it would block, because this is the check that nearly locked
    // everyone out of this portal once already. Turning it OFF is always
    // allowed with no ceremony — that's the recovery path.
    if (enabled) {
      const n = verification?.summary?.wouldBlock ?? 0;
      const total = verification?.summary?.subject ?? 0;
      const msg =
        n === 0
          ? 'No observed viewer would be blocked right now. Note that viewers this portal has never seen sign in are not counted. Turn email verification on?'
          : `This will immediately block ${n} of the ${total} viewers this portal has seen sign in.\n\nThis Auth0 tenant has no mail server, so those accounts have no way to verify themselves. Admins and managers are never blocked, so you can switch this back off.\n\nTurn email verification on anyway?`;
      if (!confirm(msg)) return;
    }
    setVerificationBusy(true);
    try {
      const res = await fetch('/api/admin/verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to update'); return; }
      setVerification((prev) => ({ ...prev, enabled: data.enabled }));
    } finally {
      setVerificationBusy(false);
    }
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

  async function runCleanup() {
    setCleaning(true);
    setCleanupMsg('');
    try {
      const res = await fetch('/api/admin/maintenance', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCleanupMsg(data.error || `Failed (status ${res.status})`);
        return;
      }
      const { bundles, shares, progress, ratings } = data;
      const total = bundles.removed + shares.removed + progress.removed;
      // The recount runs every time, so its line is shown every time — a
      // rebuilt total is a result even when nothing stale was found.
      const ratingsLine = !ratings
        ? ''
        : ratings.error
          ? ` ${ratings.error}.`
          : ` Rating totals rebuilt from ${ratings.votes} vote(s).`;
      setCleanupMsg(
        (total === 0
          ? 'Nothing stale found — all clean.'
          : `Removed ${bundles.removed} stale bundle(s), ${shares.removed} stale share reference(s), ` +
            `${progress.removed} orphaned progress record(s).`) + ratingsLine
      );
      if (shares.removed) refreshShares();
    } catch (e) {
      setCleanupMsg('Cleanup failed.');
    } finally {
      setCleaning(false);
    }
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
  const allViewerTags = [...new Set(viewers.flatMap((v) => v.tags || []))].sort();
  const pendingRequests = accessRequests.filter((r) => r.status === 'pending');

  return (
    <AppShell isAdmin>
      <div className="admin-topbar">
        <h1 className="admin-page-title">Admin</h1>
        <nav className="admin-tabs">
          {/* Only the tabs this person's capabilities open. Hiding a tab is
              presentation; every route behind it enforces its capability. */}
          {visibleTabs.map((t) => ({
            ...t,
            count: {
              videos: videos.length,
              viewers: viewers.length,
              access: pendingRequests.length || groups.length || null,
              shares: activeShares.length,
            }[t.id] ?? null,
          })).map((t) => (
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

        {visibleTabs.length === 0 && (
          <div className="card admin-section">
            <p className="text-muted">
              Your roles don&apos;t include anything managed on this page. Anything they do allow —
              removing comments, for example — is done where you watch.
            </p>
          </div>
        )}

        {tab === 'settings' && (
        <>
        {/* Appearance */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Appearance</h2>

          <div className="setting-block">
            <label htmlFor="site-name" className="collection-label">Portal name</label>
            <p className="text-muted" style={{ margin: '4px 0 8px' }}>
              Shown in the header and browser tab, on the installed app&rsquo;s icon, in push
              notifications, and in share emails. Leave blank to reset to the default.
            </p>
            <div className="admin-row">
              <input
                id="site-name"
                type="text"
                className="input input-sm"
                maxLength={MAX_SITE_NAME_LENGTH}
                placeholder="Marine Team"
                value={siteNameDraft}
                onChange={(e) => setSiteNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveSiteName()}
              />
              <button onClick={saveSiteName} className="btn btn-primary btn-sm">
                {siteNameSaved ? 'Saved!' : 'Save name'}
              </button>
            </div>
          </div>

          <AppIconSetting />

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

        {/* Performance / query monitor */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Performance Monitor</h2>
          <div className="admin-row">
            {queryMonitorEnabled
              ? <span className="badge badge-ok">Enabled</span>
              : <span className="badge badge-muted">Disabled</span>}
            <span className="text-muted">
              {queryMonitorEnabled
                ? 'A performance panel (query count/time, memory, render time) is showing on every page.'
                : 'Off. Set QUERY_MONITOR_ENABLED=true in the environment to show it on every page.'}
            </span>
          </div>
        </div>

        {/* Email verification (opt-in, off by default) */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Email Verification</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            When on, viewers whose Auth0 account reports <code>email_verified: false</code> can&rsquo;t
            open the library. Admins and managers are <strong>never</strong> blocked by this, so you
            can always come back here and switch it off.
          </p>

          <div className="verify-warning">
            <strong>Before you turn this on:</strong> this Auth0 tenant has no mail server
            configured, so verification emails never send and most accounts will report
            <code> false</code> permanently. The counts below are measured from accounts this portal
            has actually seen sign in — viewers who haven&rsquo;t signed in since this was added
            aren&rsquo;t counted yet, so the real impact can be larger.
          </div>

          {verification ? (
            <>
              <div className="verify-stats">
                <div><strong>{verification.summary.subject}</strong><span>viewers seen</span></div>
                <div><strong>{verification.summary.verified}</strong><span>verified</span></div>
                <div className={verification.summary.wouldBlock > 0 ? 'verify-stat-danger' : undefined}>
                  <strong>{verification.summary.wouldBlock}</strong><span>would be blocked</span>
                </div>
                <div><strong>{verification.summary.unknown}</strong><span>no claim (allowed)</span></div>
              </div>

              {verification.summary.wouldBlockEmails.length > 0 && (
                <details style={{ marginBottom: '1rem' }}>
                  <summary className="text-muted">
                    Who would be blocked ({verification.summary.wouldBlockEmails.length})
                  </summary>
                  <div className="viewer-tags-row" style={{ marginTop: 8 }}>
                    {verification.summary.wouldBlockEmails.map((e) => (
                      <span key={e} className="tag-chip">{e}</span>
                    ))}
                  </div>
                </details>
              )}

              {verification.bypassEmails.length > 0 && (
                <p className="text-muted">
                  Always exempt via <code>EMAIL_VERIFIED_BYPASS_EMAILS</code>:{' '}
                  {verification.bypassEmails.join(', ')}
                </p>
              )}

              <label className="admin-row">
                <input
                  type="checkbox"
                  checked={Boolean(verification.enabled)}
                  disabled={verificationBusy}
                  onChange={(e) => setVerificationEnforcement(e.target.checked)}
                />
                <span>
                  Require a verified email address to watch
                  {verification.enabled ? ' — currently ON' : ' — currently off'}
                </span>
              </label>
            </>
          ) : (
            <p className="text-muted">Loading…</p>
          )}
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

        {/* Maintenance */}
        <div className="card admin-section">
          <h2 className="admin-section-title">Maintenance</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Clears data left behind after normal use — share bundles whose links have all
            expired or been revoked, stale share references, and watch history, saved lists and
            ratings for viewers who were removed — then rebuilds the 👍/👎 totals from the votes
            that remain. Nothing currently in use is touched.
          </p>
          <div className="admin-row">
            <button
              onClick={runCleanup}
              className="btn btn-outline btn-sm"
              disabled={cleaning}
            >
              {cleaning ? 'Cleaning up…' : 'Clean up stale data'}
            </button>
            {cleanupMsg && <span className="text-muted">{cleanupMsg}</span>}
          </div>
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
                <li key={v.email} className="viewer-item viewer-item--tagged">
                  <div className="viewer-item-main">
                    <span className="viewer-email">{v.email}</span>
                    <span className="viewer-seen">{v.lastSeen ? `seen ${timeAgo(v.lastSeen)}` : 'never seen'}</span>
                    <button
                      onClick={() => removeViewer(v.email)}
                      className="btn btn-icon"
                      title="Remove viewer"
                    >
                      <IconTrash />
                    </button>
                  </div>
                  <div className="viewer-tags-row">
                    {(v.tags || []).map((t) => (
                      <span key={t} className="tag-chip">{t}</span>
                    ))}
                    <input
                      type="text"
                      className="input input-sm tag-edit-input"
                      placeholder="Tags — comma separated (e.g. Team A, Beta)"
                      value={tagDrafts[v.email] ?? (v.tags || []).join(', ')}
                      onChange={(e) => setTagDrafts((prev) => ({ ...prev, [v.email]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && saveViewerTags(v.email)}
                      onBlur={() => saveViewerTags(v.email)}
                      disabled={Boolean(tagBusy[v.email])}
                    />
                  </div>
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

          {collections.length > 0 && (
            <div className="admin-row" style={{ marginTop: '0.75rem' }}>
              <select
                className="input input-sm"
                value={bulkCollectionPick}
                onChange={(e) => setBulkCollectionPick(e.target.value)}
                style={{ flex: 'none', width: '10rem' }}
              >
                <option value="">Share collection…</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={addCollectionToBulkVideos}
                className="btn btn-outline btn-sm"
                disabled={!bulkCollectionPick}
              >
                Select videos
              </button>
            </div>
          )}

          {allViewerTags.length > 0 && (
            <div className="admin-row" style={{ marginTop: '0.75rem' }}>
              <select
                className="input input-sm"
                value={bulkTagPick}
                onChange={(e) => setBulkTagPick(e.target.value)}
                style={{ flex: 'none', width: '10rem' }}
              >
                <option value="">Add viewers tagged…</option>
                {allViewerTags.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <button
                onClick={addTagToBulkRecipients}
                className="btn btn-outline btn-sm"
                disabled={!bulkTagPick}
              >
                Add group
              </button>
            </div>
          )}

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
                      {s.expiresAt < sharesLoadedAt && <span className="badge badge-muted">Expired</span>}
                      {s.revoked && <span className="badge badge-error">Revoked</span>}
                    </span>
                    <span className="share-meta">
                      For {s.email} &middot; created {new Date(s.createdAt).toLocaleString()} &middot; expires {new Date(s.expiresAt).toLocaleString()}
                      {s.views ? ` · ${s.views} view${s.views === 1 ? '' : 's'}` : ''}
                      {s.lastViewedAt ? ` (last ${timeAgo(s.lastViewedAt)})` : ''}
                      {s.bundleId ? ' · part of a bundle' : ''}
                      {s.privateList ? ' · via Private list' : ''}
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

            {groups.length > 0 && (
              <fieldset className="upload-groups" disabled={uploading}>
                <legend className="upload-groups-legend">
                  Also visible to groups <span className="text-muted">(optional)</span>
                </legend>
                {/* Nothing is ticked by default, deliberately: a remembered
                    default would grant access on every upload long after
                    anyone remembered choosing it. */}
                {groups.map((g) => (
                  <label key={g.id} className="upload-group">
                    <input
                      type="checkbox"
                      checked={uploadGroups.includes(g.id)}
                      onChange={(e) =>
                        setUploadGroups((prev) =>
                          e.target.checked ? [...prev, g.id] : prev.filter((id) => id !== g.id)
                        )
                      }
                    />
                    {g.name}
                  </label>
                ))}
              </fieldset>
            )}

            {uploadGrantMsg && <p className="upload-grant-warning">{uploadGrantMsg}</p>}

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
          {videosTruncated && (
            <p className="text-muted" style={{ marginBottom: '1rem' }}>
              The library has more videos than this list can show — these are the newest{' '}
              {videos.length}. Older ones still play from their links.
            </p>
          )}

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

                <details className="video-schedule">
                  <summary>
                    Schedule
                    {v.scheduleState && v.scheduleState !== 'none' && (
                      <span
                        className={`schedule-chip schedule-chip--${v.scheduleState}`}
                        title={repeatSummary(v.schedule?.repeat)}
                      >
                        {v.scheduleState === 'scheduled' ? 'Not yet published' : null}
                        {v.scheduleState === 'expired' ? 'Expired' : null}
                        {v.scheduleState === 'live' ? (v.schedule?.repeat ? 'Weekly · on now' : 'Scheduled · live') : null}
                        {v.scheduleState === 'off-slot' ? 'Weekly · off now' : null}
                      </span>
                    )}
                    {v.schedule?.groups ? (
                      <span className="schedule-chip" title="Some groups have their own window">
                        +{Object.keys(v.schedule.groups).length} group
                        {Object.keys(v.schedule.groups).length === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </summary>
                  <ScheduleEditor
                    video={v}
                    groups={groups}
                    onSave={(schedule) => saveVideoSchedule(v, schedule)}
                  />
                </details>

                {can('settings:manage') && (
                  <div className="admin-video-collection">
                    <label className="collection-label">Public link</label>
                    <label className="admin-row" style={{ gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(v.isPublic)}
                        disabled={Boolean(publicBusy[v.id])}
                        onChange={(e) => toggleVideoPublic(v, e.target.checked)}
                      />
                      <span className="text-muted">
                        {v.isPublic ? 'Anyone with the link can watch — no sign-in' : 'Sign-in required'}
                      </span>
                    </label>
                    {v.isPublic && (
                      <button
                        onClick={() => copyLink(`${window.location.origin}/watch/public/${v.id}`)}
                        className="btn btn-sm"
                        style={{ marginTop: 6 }}
                      >
                        <IconCopy />
                        Copy public link
                      </button>
                    )}
                  </div>
                )}

                <details className="video-schedule">
                  <summary>
                    Chapters &amp; notes
                    {v.chapters?.length > 0 && (
                      <span className="schedule-chip">{v.chapters.length} chapter{v.chapters.length === 1 ? '' : 's'}</span>
                    )}
                    {v.notes ? <span className="schedule-chip">notes</span> : null}
                    {/* Totals only, and staff-only. The counters hold no
                        identities, so this cannot say who rated what — see
                        lib/ratings.js. */}
                    {v.rating ? (
                      <span
                        className="schedule-chip"
                        title={`${v.rating.up} up, ${v.rating.down} down, from ${v.rating.total} viewer(s)`}
                      >
                        👍 {v.rating.up} · 👎 {v.rating.down}
                      </span>
                    ) : null}
                  </summary>

                  <p className="text-muted" style={{ margin: '8px 0' }}>
                    One chapter per line, e.g. <code>24:15 Sermon</code>. Viewers get a clickable
                    list under the player. Notes are shown on the watch page and are searchable.
                  </p>

                  <label className="collection-label" htmlFor={`chapters-${v.id}`}>Chapters</label>
                  <textarea
                    id={`chapters-${v.id}`}
                    className="input input-sm"
                    rows={4}
                    placeholder={'0:00 Worship\n18:30 Announcements\n24:15 Sermon'}
                    value={metaDraft(v, 'chaptersText')}
                    onChange={(e) => setMetaDraft(v.id, 'chaptersText', e.target.value)}
                    style={{ width: '100%', resize: 'vertical' }}
                  />

                  <label className="collection-label" htmlFor={`notes-${v.id}`} style={{ marginTop: 8 }}>
                    Notes
                  </label>
                  <textarea
                    id={`notes-${v.id}`}
                    className="input input-sm"
                    rows={3}
                    placeholder="Passage, series, speaker — anything worth searching for later"
                    value={metaDraft(v, 'notes')}
                    onChange={(e) => setMetaDraft(v.id, 'notes', e.target.value)}
                    style={{ width: '100%', resize: 'vertical' }}
                  />

                  <div className="admin-row" style={{ marginTop: 8 }}>
                    <button
                      onClick={() => saveVideoMeta(v)}
                      className="btn btn-primary btn-sm"
                      disabled={Boolean(metaBusy[v.id])}
                    >
                      {metaBusy[v.id] ? 'Saving…' : 'Save chapters & notes'}
                    </button>
                    <button
                      onClick={() => suggestChapters(v)}
                      className="btn btn-sm"
                      title="Load bunny's suggested chapters into the box above — nothing is saved for you"
                    >
                      Suggest chapters
                    </button>
                  </div>
                  {suggestStatus[v.id] ? (
                    <p className="muted" style={{ marginTop: 6 }}>{suggestStatus[v.id]}</p>
                  ) : null}

                  <p className="muted" style={{ marginTop: 12, marginBottom: 6 }}>
                    Transcript — bunny.net transcribes the audio, then viewers get a
                    searchable transcript under the player and the library can be
                    searched by what was said. Costs about <strong>$0.10 per minute</strong>{' '}
                    of video, charged by bunny — the price is here rather than on an
                    invoice later.
                  </p>
                  <div className="admin-row">
                    <button
                      onClick={() => transcribeVideo(v.id, false)}
                      className="btn btn-sm"
                    >
                      Transcribe
                    </button>
                    <button
                      onClick={() => transcribeVideo(v.id, true)}
                      className="btn btn-sm"
                    >
                      Fetch captions
                    </button>
                    {transcribeStatus[v.id] ? (
                      <span className="muted">{transcribeStatus[v.id]}</span>
                    ) : null}
                  </div>
                  <label className="admin-row" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={wantChapters[v.id] === true}
                      onChange={(e) =>
                        setWantChapters((prev) => ({ ...prev, [v.id]: e.target.checked }))
                      }
                    />
                    <span className="muted">
                      Also suggest chapters from the transcript. Suggestions are never saved
                      for you — press <strong>Suggest chapters</strong> above to load them into
                      the box, then save.
                    </span>
                  </label>

                  {metaIgnored[v.id]?.length > 0 && (
                    <p className="form-error" style={{ marginTop: 8 }}>
                      Couldn&rsquo;t read {metaIgnored[v.id].length} line
                      {metaIgnored[v.id].length === 1 ? '' : 's'} — each needs a timestamp and a
                      label, like <code>24:15 Sermon</code>:
                      <br />
                      {metaIgnored[v.id].join(' · ')}
                    </p>
                  )}
                </details>

                <textarea
                  className="input input-sm"
                  placeholder="Recipient emails — separate with commas, spaces, or new lines"
                  value={emails[v.id] || ''}
                  onChange={(e) => setEmails((prev) => ({ ...prev, [v.id]: e.target.value }))}
                  rows={1}
                  style={{ width: '100%', resize: 'vertical' }}
                />

                {allViewerTags.length > 0 && (
                  <div className="admin-row" style={{ marginTop: '0.5rem' }}>
                    <select
                      className="input input-sm"
                      value={shareTagPick[v.id] || ''}
                      onChange={(e) => setShareTagPick((prev) => ({ ...prev, [v.id]: e.target.value }))}
                      style={{ flex: 'none', width: '10rem' }}
                    >
                      <option value="">Add viewers tagged…</option>
                      {allViewerTags.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => addTagToShare(v)}
                      className="btn btn-outline btn-sm"
                      disabled={!shareTagPick[v.id]}
                    >
                      Add group
                    </button>
                  </div>
                )}

                <div className="admin-video-share" style={{ marginTop: '0.5rem' }}>
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
                    Create link{(emails[v.id] || '').split(/[\s,;]+/).filter(Boolean).length > 1 ? 's' : ''}
                  </button>
                </div>

                {mailEnabled && (
                  <label className="share-notify">
                    <input
                      type="checkbox"
                      checked={Boolean(notifyShare[v.id])}
                      onChange={(e) => setNotifyShare((prev) => ({ ...prev, [v.id]: e.target.checked }))}
                    />
                    Email the link{(emails[v.id] || '').split(/[\s,;]+/).filter(Boolean).length > 1 ? 's' : ''} to the recipient{(emails[v.id] || '').split(/[\s,;]+/).filter(Boolean).length > 1 ? 's' : ''}
                  </label>
                )}

                {shareLinks[v.id]?.length > 0 && (
                  <div className="share-result-list">
                    {shareLinks[v.id].map((url) => (
                      <div className="share-result" key={url}>
                        <input
                          className="input input-sm"
                          readOnly
                          value={url}
                        />
                        <button
                          onClick={() => copyLink(url)}
                          className="btn btn-icon"
                          title="Copy link"
                        >
                          <IconCopy />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {shareMsg[v.id] && (
                  <p className="share-sent-msg text-muted">{shareMsg[v.id]}</p>
                )}

                <details className="bulk-add">
                  <summary>
                    Private list{privateLists[v.id]?.length > 0 ? ` (${privateLists[v.id].length})` : ''}
                  </summary>
                  <p className="text-muted mt-4">
                    A standing list of people with access to this video. Adding an email creates a
                    live share (and, unless unchecked, emails them) only if they aren't already on
                    the list — no duplicate share, no re-sent email for people already listed.
                    Removing someone revokes their access immediately; inviting them again later is
                    a fresh invite.
                  </p>

                  {privateLists[v.id]?.length > 0 && (
                    <ul className="analytics-list">
                      {privateLists[v.id].map((m) => (
                        <li key={m.shareId} className="analytics-row">
                          <span className="analytics-title">{m.email}</span>
                          <button
                            onClick={() => removeFromPrivateList(v, m.email)}
                            className="btn btn-icon"
                            title="Remove from private list"
                            disabled={Boolean(privateListBusy[v.id])}
                          >
                            <IconX />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {allViewerTags.length > 0 && (
                    <div className="admin-row" style={{ marginTop: '0.75rem' }}>
                      <select
                        className="input input-sm"
                        value={privateListTagPick[v.id] || ''}
                        onChange={(e) => setPrivateListTagPick((prev) => ({ ...prev, [v.id]: e.target.value }))}
                        style={{ flex: 'none', width: '10rem' }}
                      >
                        <option value="">Add viewers tagged…</option>
                        {allViewerTags.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => addTagToPrivateList(v)}
                        className="btn btn-outline btn-sm"
                        disabled={!privateListTagPick[v.id]}
                      >
                        Add group
                      </button>
                    </div>
                  )}

                  <textarea
                    className="input"
                    placeholder="Emails to add — separate with commas, spaces, or new lines"
                    value={privateListInput[v.id] || ''}
                    onChange={(e) => setPrivateListInput((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', marginTop: '10px', resize: 'vertical' }}
                  />

                  <div className="admin-video-share" style={{ marginTop: '0.5rem' }}>
                    {mailEnabled && (
                      <label className="share-notify">
                        <input
                          type="checkbox"
                          checked={privateListNotify[v.id] !== false}
                          onChange={(e) => setPrivateListNotify((prev) => ({ ...prev, [v.id]: e.target.checked }))}
                        />
                        Notify new people by email
                      </label>
                    )}
                    <button
                      onClick={() => addToPrivateList(v)}
                      className="btn btn-outline btn-sm"
                      disabled={Boolean(privateListBusy[v.id])}
                    >
                      Add to list
                    </button>
                  </div>

                  {privateListMsg[v.id] && (
                    <p className="share-sent-msg text-muted">{privateListMsg[v.id]}</p>
                  )}
                </details>

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

        {tab === 'access' && (
        <>
        {can('viewers:manage') && (
        <div className="card admin-section">
          <h2 className="admin-section-title">
            Access Requests
            {pendingRequests.length > 0 && (
              <span className="tab-count">{pendingRequests.length}</span>
            )}
          </h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            People who signed in, found they weren&rsquo;t approved, and asked for access.
            Approving adds them to the approved viewers — exactly like adding them by hand on the
            Viewers tab. Denying leaves them signed out of the library and never removes anyone who
            already has access.
          </p>

          {accessRequests.length === 0 ? (
            <p className="text-muted">No access requests.</p>
          ) : (
            <ul className="viewer-list">
              {accessRequests.map((r) => (
                <li key={r.email} className="viewer-item viewer-item--tagged">
                  <div className="viewer-item-main">
                    <span className="viewer-email">{r.email}</span>
                    <span className={`role-chip role-chip--${r.status}`}>{r.status}</span>
                    <span className="viewer-seen">{r.requestedAt ? timeAgo(r.requestedAt) : ''}</span>
                    {r.status === 'pending' ? (
                      <>
                        <button
                          onClick={() => decideAccessRequest(r.email, 'approved')}
                          className="btn btn-primary btn-sm"
                          disabled={Boolean(requestBusy[r.email])}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => decideAccessRequest(r.email, 'denied')}
                          className="btn btn-sm"
                          disabled={Boolean(requestBusy[r.email])}
                        >
                          Deny
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => dismissAccessRequest(r.email)}
                        className="btn btn-icon"
                        title="Remove this request from the list"
                      >
                        <IconTrash />
                      </button>
                    )}
                  </div>
                  {r.note && <p className="request-note">{r.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        {can('roles:manage') && <RolesSection onViewersChanged={reloadViewers} />}

        {can('groups:manage') && (
        <div className="card admin-section">
          <h2 className="admin-section-title">Viewer Groups</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            A group grants its members access to specific collections and videos. A viewer who is
            in <strong>no group sees the whole library</strong>, exactly as before — groups only
            ever narrow access, and only for the people you put in one. Share links are separate
            and keep working regardless of groups.
          </p>
          {!can('videos:manage') && (
            <p className="text-muted" style={{ marginBottom: '1rem' }}>
              Your roles don&apos;t include <code>videos:manage</code>, so the library isn&apos;t listed
              here to grant from — you can still rename and delete groups.
            </p>
          )}
          {!can('viewers:manage') && (
            <p className="text-muted" style={{ marginBottom: '1rem' }}>
              Changing who is in a group also needs <code>viewers:manage</code>, so you see how many
              members each group has but not who they are.
            </p>
          )}

          <div className="admin-row">
            <input
              type="text"
              placeholder="Group name (e.g. Deck Crew)"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createGroup()}
              className="input input-sm"
            />
            <button onClick={createGroup} className="btn btn-primary btn-sm">Create group</button>
          </div>

          {groupError && <p className="form-error">{groupError}</p>}

          {groups.length === 0 ? (
            <p className="text-muted mt-4">
              No groups yet — every approved viewer can see the whole library.
            </p>
          ) : (
            <div className="group-list">
              {groups.map((g) => {
                const grantCount = (g.collectionIds || []).length + (g.videoIds || []).length;
                // Without viewers:manage the route sends a count, not the people.
                const memberCount = Array.isArray(g.members) ? g.members.length : g.memberCount || 0;
                return (
                  <div key={g.id} className="group-card">
                    <div className="group-card-head">
                      <h3 className="group-name">{g.name}</h3>
                      <span className="text-muted">
                        {memberCount} member{memberCount === 1 ? '' : 's'} · {grantCount} grant
                        {grantCount === 1 ? '' : 's'}
                      </span>
                      <button
                        onClick={() => deleteGroup(g.id, g.name)}
                        className="btn btn-icon"
                        title="Delete group"
                      >
                        <IconTrash />
                      </button>
                    </div>

                    {memberCount > 0 && grantCount === 0 && (
                      <p className="group-warning">
                        This group has members but grants nothing, so they currently see no videos
                        at all. Tick a collection or video below, or remove the members.
                      </p>
                    )}

                    {Array.isArray(g.members) && (
                    <div className="group-section">
                      <span className="group-section-label">Members</span>
                      <div className="viewer-tags-row">
                        {g.members.map((m) => (
                          <span key={m} className="tag-chip">
                            {m}
                            <button
                              onClick={() => removeGroupMember(g.id, m)}
                              className="tag-chip-x"
                              title={`Remove ${m} from ${g.name}`}
                            >
                              <IconX />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="admin-row">
                        <input
                          type="text"
                          className="input input-sm"
                          placeholder="Add viewers — comma or space separated"
                          value={groupMemberDrafts[g.id] ?? ''}
                          onChange={(e) =>
                            setGroupMemberDrafts((prev) => ({ ...prev, [g.id]: e.target.value }))
                          }
                          onKeyDown={(e) => e.key === 'Enter' && addGroupMembers(g.id)}
                        />
                        <button onClick={() => addGroupMembers(g.id)} className="btn btn-sm">Add</button>
                      </div>
                    </div>
                    )}

                    <div className="group-section">
                      <span className="group-section-label">Collections</span>
                      {collections.length === 0 ? (
                        <p className="text-muted">No collections in the library yet.</p>
                      ) : (
                        <div className="group-grant-grid">
                          {collections.map((c) => (
                            <label key={c.id} className="group-grant-item">
                              <input
                                type="checkbox"
                                checked={(g.collectionIds || []).includes(c.id)}
                                disabled={Boolean(groupBusy[g.id])}
                                onChange={() => toggleGroupGrant(g, 'collectionIds', c.id)}
                              />
                              <span>{c.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    <details className="group-section">
                      <summary className="group-section-label">
                        Individual videos ({(g.videoIds || []).length})
                      </summary>
                      <div className="group-grant-grid">
                        {videos.map((v) => (
                          <label key={v.id} className="group-grant-item">
                            <input
                              type="checkbox"
                              checked={(g.videoIds || []).includes(v.id)}
                              disabled={Boolean(groupBusy[g.id])}
                              onChange={() => toggleGroupGrant(g, 'videoIds', v.id)}
                            />
                            <span>{v.title || 'Untitled'}</span>
                          </label>
                        ))}
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}
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
              {analytics.truncated && (
                <p className="text-muted">
                  Total views, watch time and most-watched cover the newest{' '}
                  {formatNumber(analytics.covered)} videos, not the whole library.
                </p>
              )}

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
