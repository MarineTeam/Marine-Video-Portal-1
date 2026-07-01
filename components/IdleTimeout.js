import { useEffect, useRef } from 'react';
import { useUser } from '@auth0/nextjs-auth0/client';

// Auto sign-out after this much inactivity. Protects a portal left open on a
// shared or unattended machine.
const IDLE_MS = 30 * 60 * 1000; // 30 minutes

export default function IdleTimeout() {
  const { user } = useUser();
  const timer = useRef(null);
  const lastReset = useRef(0);

  useEffect(() => {
    if (!user) return;

    const logout = () => {
      window.location.href = '/api/auth/logout?returnTo=/';
    };

    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(logout, IDLE_MS);
    };

    // Throttle so we don't reset the timer on every mousemove.
    const onActivity = () => {
      const now = Date.now();
      if (now - lastReset.current > 5000) {
        lastReset.current = now;
        reset();
      }
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    reset();

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      if (timer.current) clearTimeout(timer.current);
    };
  }, [user]);

  return null;
}
