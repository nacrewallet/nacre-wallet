// Lightweight non-blocking toast — mirrors the mobile wallet's pattern
// (e:\VIBE\pearlchain-mobile\src\ui\toast.tsx). Module-level emit listener,
// host component subscribes. 1700ms display, auto-fades.

import { useEffect, useState } from 'react';

type Listener = (msg: string) => void;
let listener: Listener | null = null;

export function toast(msg: string): void {
  listener?.(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    listener = (m) => {
      setMsg(m);
      window.setTimeout(() => setMsg(null), 1700);
    };
    return () => { listener = null; };
  }, []);
  if (!msg) return null;
  return (
    <div
      className="toast-host"
      role="status"
      aria-live="polite"
    >
      <div className="toast-message">
        {msg}
      </div>
    </div>
  );
}
