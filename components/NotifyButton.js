import { useEffect, useState } from 'react';
import { IconBell, IconBellOff } from './icons';

// The VAPID public key is inlined at build time. When it's absent the whole
// feature is off, so this button renders nothing.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

// Convert a base64url VAPID key to the Uint8Array the Push API expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// "Notify me" toggle for approved viewers. State machine:
//   'loading'  — checking current subscription
//   'off'      — supported, not subscribed
//   'on'       — subscribed
//   'denied'   — browser permission blocked
//   'working'  — a subscribe/unsubscribe request is in flight
export default function NotifyButton() {
  const [state, setState] = useState('loading');

  useEffect(() => {
    if (!VAPID_PUBLIC_KEY || !pushSupported()) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

  async function subscribe() {
    setState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      });
      if (!res.ok) throw new Error('subscribe failed');
      setState('on');
    } catch (e) {
      setState('off');
    }
  }

  async function unsubscribe() {
    setState('working');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setState('off');
    } catch (e) {
      setState('on');
    }
  }

  if (state === 'unsupported' || state === 'loading') return null;

  if (state === 'denied') {
    return (
      <button className="btn btn-ghost btn-sm" disabled title="Notifications are blocked in your browser settings">
        <IconBellOff />
        Notifications blocked
      </button>
    );
  }

  if (state === 'on') {
    return (
      <button className="btn btn-ghost btn-sm" onClick={unsubscribe} title="Turn off new-video notifications">
        <IconBell />
        Notifications on
      </button>
    );
  }

  return (
    <button
      className="btn btn-outline btn-sm"
      onClick={subscribe}
      disabled={state === 'working'}
      title="Get notified when a new video is ready"
    >
      <IconBell />
      {state === 'working' ? 'Enabling…' : 'Notify me'}
    </button>
  );
}
