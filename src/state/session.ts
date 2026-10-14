// Session state. Two layers:
//
//  1. In-memory HD key — fastest to derive addresses, cleared when the popup
//     unmounts (which happens every popup-close).
//  2. chrome.storage.session — in-process memory across SW restarts and
//     popup-close/open cycles. Cleared on browser exit AND when the
//     background SW's auto-lock alarm fires.
//
// On popup open, we check (2): if a mnemonic is cached, we re-derive the HD
// key (fast, no PBKDF2 needed) and the user skips the password prompt.

import type { HDKey } from '@scure/bip32';
import { mnemonicToHDKey } from '@/pearl/wallet';

const SESSION_KEY = 'pearl.session.mnemonic';
const AUTOLOCK_ALARM = 'pearl.autolock';

interface SessionState { hd: HDKey | null; mnemonic: string | null; unlockedAt: number }
const state: SessionState = { hd: null, mnemonic: null, unlockedAt: 0 };
let generation = 0;

// An auto-lock in the background must also revoke keys held by an open popup.
// Content scripts never receive this event or any mnemonic (trusted contexts only).
function forgetSession(): void {
  generation++;
  state.hd = null;
  state.mnemonic = null;
  state.unlockedAt = 0;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nacre:locked'));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && SESSION_KEY in changes && !changes[SESSION_KEY].newValue) {
    forgetSession();
  }
});

function sessionGet(): Promise<string | null> {
  return new Promise(resolve => {
    chrome.storage.session.get([SESSION_KEY], (res) => resolve((res[SESSION_KEY] as string) ?? null));
  });
}
function sessionSet(value: string): Promise<void> {
  return new Promise(resolve => { chrome.storage.session.set({ [SESSION_KEY]: value }, () => resolve()); });
}
function sessionClear(): Promise<void> {
  return new Promise(resolve => { chrome.storage.session.remove([SESSION_KEY], () => resolve()); });
}

async function scheduleAutoLock(expectedGeneration: number): Promise<void> {
  // Look up the configured timeout (-1 = never, 0 = immediately, N min = after N).
  const { 'pearlchain.wallet.meta': meta } = await new Promise<{[k:string]: { autoLockMins?: number }}>(
    (resolve) => chrome.storage.local.get(['pearlchain.wallet.meta'], (r) => resolve(r as {[k:string]: { autoLockMins?: number }}))
  );
  assertGeneration(expectedGeneration);
  const mins = meta?.autoLockMins ?? 5;
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  assertGeneration(expectedGeneration);
  if (mins > 0) {
    chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: mins });
  } else if (mins === 0) {
    // Lock immediately when popup closes — nothing to schedule; the SW
    // listener clears the session whenever the popup port disconnects.
  }
  // mins === -1 → never; leave no alarm set
}

function assertGeneration(expected: number): void {
  if (generation !== expected) throw new Error('Unlock was interrupted by a session change. Please unlock again.');
}

export async function unlock(mnemonic: string): Promise<void> {
  const expected = ++generation;
  const hd = await mnemonicToHDKey(mnemonic);
  assertGeneration(expected);
  await sessionSet(mnemonic);
  // A removal can arrive while storage.set is in flight. Do not leave that
  // stale write available for the next popup to restore after a lock.
  if (generation !== expected) {
    if (await sessionGet() === mnemonic) await sessionClear();
    assertGeneration(expected);
  }
  await scheduleAutoLock(expected);
  const current = await sessionGet();
  assertGeneration(expected);
  if (current !== mnemonic) throw new Error('The wallet session was removed. Please unlock again.');
  // Publish keys only after every asynchronous operation and revalidation.
  state.hd = hd;
  state.mnemonic = mnemonic;
  state.unlockedAt = Date.now();
}

export async function lock(): Promise<void> {
  forgetSession();
  await sessionClear();
  await chrome.alarms.clear(AUTOLOCK_ALARM);
}

// Called by popup App on mount to restore the HD key from session storage if
// the user previously unlocked in this browser session.
export async function restoreFromSession(): Promise<boolean> {
  if (state.hd) return true;
  const expected = generation;
  const m = await sessionGet();
  if (!m || generation !== expected) return false;
  try {
    const hd = await mnemonicToHDKey(m);
    if (generation !== expected) return false;
    // Also catch removals whose storage-change event has not reached us yet.
    const current = await sessionGet();
    if (generation !== expected || current !== m) return false;
    state.hd = hd;
    state.mnemonic = m;
    state.unlockedAt = Date.now();
    return true;
  } catch {
    // An obsolete restore must not clear a newer, explicitly unlocked session.
    if (generation === expected) await sessionClear();
    return false;
  }
}

export function isUnlocked(): boolean { return state.hd != null; }
export function getHD(): HDKey | null { return state.hd; }
export function getMnemonic(): string | null { return state.mnemonic; }
export function getUnlockedAt(): number { return state.unlockedAt; }
