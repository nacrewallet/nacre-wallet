import { useState, useRef, useEffect } from 'react';
import { unlockMnemonic } from '@/storage/vault';
import { unlock as sessionUnlock } from '@/state/session';
import { toast } from '@/ui/Toast';
import { NacreBrand } from '@/ui/NacreBrand';
import shellUrl from '@/assets/nacre-shell.svg';

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function tryUnlock() {
    if (!pw || busy) return;
    setBusy(true);
    try {
      const mnemonic = await unlockMnemonic(pw);
      if (!mnemonic) { toast('Incorrect password. Try again.'); return; }
      await sessionUnlock(mnemonic);
      onUnlocked();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to unlock your wallet.');
    } finally { setBusy(false); }
  }

  return (
    <form className="welcome-screen" onSubmit={(event) => { event.preventDefault(); void tryUnlock(); }}>
      <div className="welcome-top"><NacreBrand /><span className="network-label">PEARL WALLET</span></div>
      <div className="unlock-main">
        <img className="unlock-art nacre-mark" src={shellUrl} alt="" />
        <div className="unlock-copy"><h1>Welcome back.</h1><p>Your Pearl is right where you left it.</p></div>
        <div className="unlock-form">
          <label htmlFor="wallet-password">Wallet password</label>
          <input id="wallet-password" ref={inputRef} type="password" autoComplete="current-password" value={pw} onChange={(event) => setPw(event.target.value)} placeholder="Enter your password" />
        </div>
      </div>
      <button type="submit" disabled={!pw || busy} className="pearl-btn">{busy ? 'Unlocking…' : 'Unlock wallet'}</button>
      <p className="welcome-note">Your keys stay encrypted on this device</p>
    </form>
  );
}