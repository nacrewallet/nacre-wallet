import { useEffect, useRef, useState } from 'react';
import { Onboarding } from '@/screens/Onboarding';
import { Create }     from '@/screens/Create';
import { Import }     from '@/screens/Import';
import { Unlock }     from '@/screens/Unlock';
import { Dashboard, type TxClickArgs } from '@/screens/Dashboard';
import { Activity }   from '@/screens/Activity';
import { Send }       from '@/screens/Send';
import { Receive }    from '@/screens/Receive';
import { Settings }   from '@/screens/Settings';
import { AddAccount } from '@/screens/AddAccount';
import { ViewSeed }   from '@/screens/ViewSeed';
import { ExportKey }  from '@/screens/ExportKey';
import { TxDetail }   from '@/screens/TxDetail';
import { Addresses }  from '@/screens/Addresses';
import { Contacts }   from '@/screens/Contacts';
import { Names }      from '@/screens/Names';
import { TabBar, type Tab } from '@/ui/TabBar';
import { ToastHost, toast } from '@/ui/Toast';
import { hasWallet, loadMeta } from '@/storage/vault';
import { isUnlocked, restoreFromSession } from '@/state/session';
import { setBackend } from '@/api/client';
import { clearCache } from '@/state/walletState';
import { DappApproval } from '@/screens/DappApproval';
import { claimApproval } from '@/dapp/approval-client';
import { watchApproval } from '@/dapp/approval-discovery';
import { maintainPopupPort } from '@/dapp/popup-port';

export type Screen =
  | 'loading'
  | 'onboarding' | 'create' | 'import' | 'unlock'
  | 'dashboard' | 'activity' | 'send' | 'receive' | 'settings' | 'add-account'
  | 'view-seed' | 'export-key' | 'tx-detail' | 'addresses' | 'contacts' | 'pick-contact' | 'names';

// Screens that participate in the bottom tab bar.
const TAB_SCREENS: Screen[] = ['dashboard', 'activity', 'settings'];

export function App() {
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState('');
  const retryApproval = useRef<() => void>(() => {});
  const [screen, setScreen] = useState<Screen>('loading');
  const [txArgs, setTxArgs] = useState<TxClickArgs | null>(null);
  const [sendPrefill, setSendPrefill] = useState<{ recipient?: string; amount?: string }>({});

  useEffect(() => {
    if (approvalId) return;
    const discovery = watchApproval({
      claim: claimApproval,
      focusTarget: window,
      onClaim: (requestId) => {
        setApprovalId(requestId);
        // Bring a delayed request forward without interrupting create/import,
        // unlock or a payment that the user is composing in the wallet.
        setScreen(current => TAB_SCREENS.includes(current) ? 'dashboard' : current);
      },
      onError: (error) => setApprovalError(error === null ? '' : error instanceof Error ? error.message : 'Could not open the website request.'),
    });
    retryApproval.current = discovery.retry;
    return () => { discovery.stop(); retryApproval.current = () => {}; };
  }, [approvalId]);

  useEffect(() => {
    let stopped = false;
    const onLocked = () => { clearCache(); setScreen('unlock'); };
    window.addEventListener('nacre:locked', onLocked);
    const stopPopupPort = maintainPopupPort();
    (async () => {
      const meta = await loadMeta();
      if (stopped) return;
      if (meta?.explorerUrl && meta?.explorerMode) {
        setBackend(meta.explorerUrl, meta.explorerMode);
      }
      const exists = await hasWallet();
      if (stopped) return;
      if (!exists) { setScreen('onboarding'); return; }
      const restored = isUnlocked() || (await restoreFromSession());
      if (!stopped) setScreen(restored ? 'dashboard' : 'unlock');
    })();
    return () => { stopped = true; stopPopupPort(); window.removeEventListener('nacre:locked', onLocked); };
  }, []);

  const showApproval = !!approvalId && screen === 'dashboard';
  const showTabBar = !showApproval && TAB_SCREENS.includes(screen);
  const activeTab: Tab = screen === 'activity' ? 'activity' : screen === 'settings' ? 'settings' : 'dashboard';

  return (
    <div className="popup-shell flex flex-col">
      {approvalError && !approvalId && <div role="alert" className="shrink-0 border-b border-ink-600 bg-ink-800 px-4 py-3 text-xs">
        <p className="font-medium">Website request unavailable</p>
        <p className="mt-1 text-pearl-400 break-words">{approvalError} Retry, or close and reopen Nacre Wallet.</p>
        <button type="button" className="mt-2 underline underline-offset-2" onClick={() => retryApproval.current()}>Retry request</button>
      </div>}
      {screen === 'loading' && (
        <div className="flex-1 flex items-center justify-center text-xs text-pearl-600">Loading…</div>
      )}

      {screen === 'onboarding' && (
        <Onboarding onCreate={() => setScreen('create')} onImport={() => setScreen('import')} />
      )}

      {screen === 'create' && (
        <Create onBack={() => setScreen('onboarding')} onDone={() => setScreen('dashboard')} />
      )}

      {screen === 'import' && (
        <Import onBack={() => setScreen('onboarding')} onDone={() => setScreen('dashboard')} />
      )}

      {screen === 'unlock' && (
        <Unlock onUnlocked={() => setScreen('dashboard')} />
      )}

      {showApproval && <DappApproval requestId={approvalId!} onDone={() => setApprovalId(null)} />}

      {screen === 'dashboard' && !showApproval && (
        <Dashboard
          onSend={() => { setSendPrefill({}); setScreen('send'); }}
          onReceive={() => setScreen('receive')}
          onLocked={() => setScreen('unlock')}
          onAddAccount={() => setScreen('add-account')}
        />
      )}

      {screen === 'activity' && (
        <Activity onOpenTx={(args) => { setTxArgs(args); setScreen('tx-detail'); }} />
      )}

      {screen === 'add-account' && (
        <AddAccount onBack={() => setScreen('dashboard')} onDone={() => setScreen('dashboard')} />
      )}

      {screen === 'send' && (
        <Send
          onBack={() => setScreen('dashboard')}
          onSent={(txid) => { toast(`Sent: ${txid.slice(0, 10)}…`); setSendPrefill({}); setScreen('dashboard'); }}
          onPickContact={() => setScreen('pick-contact')}
          initialRecipient={sendPrefill.recipient}
          initialAmount={sendPrefill.amount}
        />
      )}

      {screen === 'receive' && (
        <Receive onBack={() => setScreen('dashboard')} />
      )}

      {screen === 'settings' && (
        <Settings
          onBack={() => setScreen('dashboard')}
          onLocked={() => setScreen('unlock')}
          onDeleted={() => setScreen('onboarding')}
          onViewSeed={() => setScreen('view-seed')}
          onExportKey={() => setScreen('export-key')}
          onAddresses={() => setScreen('addresses')}
          onContacts={() => setScreen('contacts')}
          onNames={() => setScreen('names')}
        />
      )}

      {screen === 'names' && (
        <Names onBack={() => setScreen('settings')} />
      )}

      {screen === 'view-seed' && (
        <ViewSeed onBack={() => setScreen('settings')} />
      )}

      {screen === 'export-key' && (
        <ExportKey onBack={() => setScreen('settings')} />
      )}

      {screen === 'tx-detail' && txArgs && (
        <TxDetail {...txArgs} onBack={() => setScreen('activity')} />
      )}

      {screen === 'addresses' && (
        <Addresses onBack={() => setScreen('settings')} />
      )}

      {screen === 'contacts' && (
        <Contacts onBack={() => setScreen('settings')} />
      )}

      {screen === 'pick-contact' && (
        <Contacts
          onBack={() => setScreen('send')}
          onPick={(address) => { setSendPrefill({ ...sendPrefill, recipient: address }); setScreen('send'); }}
        />
      )}

      {showTabBar && <TabBar active={activeTab} onChange={(t) => setScreen(t)} />}

      <ToastHost />
    </div>
  );
}
