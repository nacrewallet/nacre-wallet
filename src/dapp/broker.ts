import { ProviderError, REQUEST_TTL, type ApprovalIdentity, type Payment, type RequestArgs, type RpcError, type SiteIdentity } from './protocol';
import { freshBalance, validatePublicBalance, type PublicBalance } from './balance-contract';
import type { BalanceWatch } from './balance-watch';
import { parsePearlAmount } from '@/pearl/money';
import { assertTotalDebit, parseTotalDebitCap } from '@/pearl/payment-budget';

export type RequestStatus = 'pending' | 'signing' | 'broadcasting' | 'completed' | 'rejected';
export interface Connection { address: string; accountId: string; balanceAccess?: true; balanceWatch?: BalanceWatch }
export type WalletResult = string[] | { txid: string } | PublicBalance | null;
export interface PendingRequest {
  id: string; clientId: string; owner: SiteIdentity; args: RequestArgs;
  createdAt: number; expiresAt: number; status: RequestStatus;
  approvalDocumentId?: string; account?: Connection;
  fee?: string; txid?: string; result?: WalletResult; error?: RpcError;
}
export interface BrokerState { version: 1; requests: PendingRequest[]; grants: Record<string, Connection>; balances?: Record<string, PublicBalance> }
export interface PublicStatus { pending: boolean; result?: WalletResult; error?: RpcError }
export interface BrokerDependencies {
  read(): Promise<BrokerState | undefined>;
  write(state: BrokerState): Promise<void>;
  now(): number;
  id(): string;
  openApproval(windowId: number): Promise<void>;
  accountId(): Promise<string | undefined>;
  balanceAccountId?(): Promise<string | undefined>;
  refreshBalance?(account: Connection, signal: AbortSignal): Promise<PublicBalance>;
}
const active = (r: PendingRequest) => ['pending', 'signing', 'broadcasting'].includes(r.status);
export const BALANCE_SCAN_TIMEOUT = 45_000;
const sameOwner = (a: SiteIdentity, b: SiteIdentity) => a.origin === b.origin && a.tabId === b.tabId && a.windowId === b.windowId && a.documentId === b.documentId;
const sameArgs = (a: RequestArgs, b: RequestArgs) => JSON.stringify(a) === JSON.stringify(b);
const rejected = (r: PendingRequest, code: number, message: string) => {
  r.status = 'rejected'; r.error = { code, message }; delete r.result;
};

// All mutations are serialized, including storage writes. State is public data
// only and survives service-worker suspension in chrome.storage.session.
export class RequestBroker {
  private queue: Promise<unknown> = Promise.resolve();
  private state?: BrokerState;
  private balanceGeneration = 0;
  private balanceReads = new Map<string, Promise<PublicBalance | null>>();
  constructor(private readonly deps: BrokerDependencies) {}
  private serial<T>(fn: (s: BrokerState) => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      if (!this.state) {
        this.state = await this.deps.read() ?? { version: 1, requests: [], grants: {} };
        // Never resume signing or submit a transaction again after a restart.
        for (const r of this.state.requests) {
          if (r.status === 'pending' && !Number.isInteger(r.owner.windowId)) rejected(r, 4001, 'This request predates the toolbar upgrade. Start a new request from Nacre.');
          if (r.status === 'signing') rejected(r, 4001, 'Approval was interrupted. No transaction was submitted by this request.');
          if (r.status === 'broadcasting') {
            rejected(r, -32002, 'Submission outcome is unknown. Check the transaction ID before taking any further action.');
            r.error!.data = { txid: r.txid! };
          }
        }
        await this.deps.write(this.state);
      }
      const s = this.state;
      for (const r of s.requests) {
        if ((r.status === 'pending' || r.status === 'signing') && r.expiresAt <= this.deps.now()) {
          rejected(r, 4001, 'This wallet request has expired.');
        }
      }
      // Persist expiry even when the requested operation subsequently rejects.
      await this.deps.write(s);
      const result = await fn(s);
      await this.deps.write(s);
      return structuredClone(result);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  accounts(owner: SiteIdentity): Promise<string[]> {
    return this.serial(async s => {
      const grant = s.grants[owner.origin];
      return grant && grant.accountId === await this.deps.accountId() ? [grant.address] : [];
    });
  }
  async balance(owner: SiteIdentity): Promise<PublicBalance | null> {
    const generation = this.balanceGeneration;
    const result = await this.serial(async s => this.readBalance(s, owner.origin));
    // Storage writes are asynchronous too: a lock/account event arriving after
    // the read but before the serialized response must still suppress it.
    return generation === this.balanceGeneration ? result : null;
  }
  private async readBalance(s: BrokerState, origin: string): Promise<PublicBalance | null> {
    const generation = this.balanceGeneration;
    const grant = s.grants[origin];
    const accountId = await (this.deps.balanceAccountId ?? this.deps.accountId)();
    if (generation !== this.balanceGeneration || !grant?.balanceAccess || grant.accountId !== accountId) return null;
    return freshBalance(s.balances?.[origin], grant.address, this.deps.now());
  }
  refreshBalance(owner: SiteIdentity): Promise<PublicBalance | null> {
    const existing = this.balanceReads.get(owner.origin);
    if (existing) return existing;
    const generation = this.balanceGeneration;
    const job = (async () => {
      const account = await this.serial(async s => {
        const grant = s.grants[owner.origin];
        if (!grant?.balanceAccess || !grant.balanceWatch || grant.accountId !== await (this.deps.balanceAccountId ?? this.deps.accountId)()) {
          throw new ProviderError(4100, 'Reconnect Nacre Wallet and allow balance access, then keep the wallet unlocked.');
        }
        if (s.requests.some(r => r.args.method === 'sendTransaction' && active(r))) throw new ProviderError(-32002, 'A payment is in progress. Refresh the balance after it completes.');
        return grant;
      });
      if (generation !== this.balanceGeneration) return null;
      if (!this.deps.refreshBalance) throw new ProviderError(4200, 'Automatic balance updates are unavailable. Update Nacre Wallet.');
      // A response body can stall even after an HTTP header timeout ends. Bound
      // the complete scan and release deduplication so a later read can retry.
      // Only the winning result continues below; a late scan cannot publish.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const value = await new Promise<PublicBalance>((resolve, reject) => {
        deadline = setTimeout(() => { reject(new ProviderError(-32000, 'The balance scan timed out. Try refreshing again.')); controller.abort(); }, BALANCE_SCAN_TIMEOUT);
        void this.deps.refreshBalance!(account, controller.signal).then(resolve, reject);
      }).finally(() => { if (deadline !== undefined) clearTimeout(deadline); });
      const snapshot = validatePublicBalance(value, this.deps.now());
      if (snapshot.address !== account.address) throw new ProviderError(4100, 'The balance belongs to another account.');
      const result = await this.serial(async s => {
        const selected = await (this.deps.balanceAccountId ?? this.deps.accountId)();
        if (generation !== this.balanceGeneration || selected !== account.accountId || JSON.stringify(s.grants[owner.origin]) !== JSON.stringify(account)) return null;
        if (s.requests.some(r => r.args.method === 'sendTransaction' && active(r))) return null;
        (s.balances ??= {})[owner.origin] = snapshot;
        return snapshot;
      });
      return generation === this.balanceGeneration ? result : null;
    })();
    this.balanceReads.set(owner.origin, job);
    void job.finally(() => { if (this.balanceReads.get(owner.origin) === job) this.balanceReads.delete(owner.origin); }).catch(() => {});
    return job;
  }
  invalidateBalances(): Promise<void> {
    // Increment synchronously so an account-change event invalidates a read
    // already awaiting storage, even before its serialized cleanup can run.
    this.balanceGeneration++;
    this.balanceReads.clear();
    return this.serial(async s => {
      s.balances = {};
      for (const r of s.requests) if (r.args.method === 'getBalance') {
        if (r.status === 'pending') rejected(r, 4001, 'The wallet account, network or lock state changed. Refresh the balance again.');
        if (r.status === 'completed') r.result = null;
      }
    });
  }
  hasPendingApproval(): Promise<boolean> {
    return this.serial(async s => s.requests.some(r => r.status === 'pending'));
  }
  connections(): Promise<Array<{ origin: string; address: string }>> {
    return this.serial(async s => {
      const id = await this.deps.accountId();
      return Object.entries(s.grants).filter(([, c]) => c.accountId === id).map(([origin, c]) => ({ origin, address: c.address }));
    });
  }
  revoke(origin: string): Promise<null> { return this.disconnect({ origin, tabId: -1, windowId: -1, documentId: '' }); }
  revokeAll(): Promise<void> {
    this.balanceGeneration++;
    this.balanceReads.clear();
    return this.serial(async s => {
      s.grants = {};
      s.balances = {};
      for (const r of s.requests) if (r.status === 'pending' || r.status === 'signing') {
        rejected(r, 4001, 'The wallet connection was removed.');
      }
    });
  }
  disconnect(owner: SiteIdentity): Promise<null> {
    this.balanceGeneration++;
    this.balanceReads.clear();
    return this.serial(async s => {
      delete s.grants[owner.origin];
      if (s.balances) delete s.balances[owner.origin];
      for (const r of s.requests) if (r.owner.origin === owner.origin && (r.status === 'pending' || r.status === 'signing')) {
        rejected(r, 4001, 'The website disconnected from Nacre Wallet.');
      }
      return null;
    });
  }
  async create(owner: SiteIdentity, clientId: string, args: RequestArgs): Promise<{ id: string }> {
    // Capture before the first await: callers cannot mutate a queued request/cap.
    owner = structuredClone(owner); args = structuredClone(args);
    const created = await this.serial(async s => {
      const exact = s.requests.find(r => sameOwner(owner, r.owner) && r.clientId === clientId);
      if (exact) {
        if (!sameArgs(exact.args, args)) throw new ProviderError(-32602, 'A request ID cannot be reused with different parameters.');
        return { id: exact.id, open: false };
      }
      if (args.method !== 'connect' && args.method !== 'sendTransaction' && args.method !== 'getBalance') throw new ProviderError(4200, 'Invalid approval method.');
      if (args.method === 'connect' || args.method === 'getBalance') {
        // A second click from the same page resumes its existing consent prompt.
        // Keep its original expiry and identity; never replace a payment or a
        // request belonging to another document/window.
        const waiting = s.requests.find(r => r.status === 'pending' && r.args.method === args.method && sameOwner(owner, r.owner));
        if (waiting) return { id: waiting.id, open: true };
      }
      let account: Connection | undefined;
      if (args.method === 'getBalance') {
        account = s.grants[owner.origin];
        if (!account || account.accountId !== await this.deps.accountId()) throw new ProviderError(4100, 'Connect the selected mainnet account before sharing its balance.');
        if (!args.params?.refresh) throw new ProviderError(-32602, 'Balance refresh must be explicitly requested.');
      }
      if (args.method === 'sendTransaction') {
        account = s.grants[owner.origin];
        if (!account || account.accountId !== await this.deps.accountId()) throw new ProviderError(4100, 'Connect the selected mainnet account before requesting a payment.');
        // orderId is a safety key across documents/tabs in the browser session.
        // A site cannot silently replace a previous payment under that key.
        const duplicate = s.requests.find(r => r.owner.origin === owner.origin && r.args.method === 'sendTransaction'
          && (args.params!.orderId ? r.args.params!.orderId === args.params!.orderId : active(r) && sameArgs(r.args, args)));
        if (duplicate) {
          if (!sameArgs(duplicate.args, args)) throw new ProviderError(-32602, 'This order ID is already bound to another payment.');
          if (sameOwner(owner, duplicate.owner)) return { id: duplicate.id, open: false };
          throw new ProviderError(-32002, 'This payment has already been requested. Check the original request before retrying.', duplicate.txid ? { txid: duplicate.txid } : undefined);
        }
      }
      if (s.requests.some(r => active(r))) throw new ProviderError(-32002, 'Another wallet approval or payment is in progress.');
      // Do not evict idempotency keys mid-session: refuse new work at the cap.
      if (s.requests.length >= 500) throw new ProviderError(-32005, 'Wallet request capacity reached for this browser session.');
      const id = this.deps.id();
      s.requests.push({ id, clientId, owner, args, createdAt: this.deps.now(), expiresAt: this.deps.now() + REQUEST_TTL, status: 'pending', ...(account ? { account } : {}) });
      return { id, open: true };
    });
    if (created.open) {
      try {
        // The request is already persisted. A browser policy/focus restriction
        // must not lose it: the user can click the badged toolbar icon instead.
        await this.deps.openApproval(owner.windowId);
      } catch {
        // Keep pending until the native toolbar is opened or the TTL expires.
      }
    }
    return { id: created.id };
  }
  async status(owner: SiteIdentity, id: string): Promise<PublicStatus> {
    const generation = this.balanceGeneration;
    const result = await this.serial(async s => {
      const r = s.requests.find(r => r.id === id && sameOwner(owner, r.owner));
      if (!r) throw new ProviderError(4100, 'This request does not belong to this website document.');
      if (r.args.method === 'getBalance' && r.status === 'completed') return { pending: false, result: await this.readBalance(s, owner.origin) };
      return active(r) ? { pending: true } : { pending: false, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}) };
    });
    if (generation !== this.balanceGeneration && result.result && !Array.isArray(result.result) && 'network' in result.result) return { pending: false, result: null };
    return result;
  }
  claim(context: ApprovalIdentity): Promise<string | null> {
    return this.serial(async s => {
      const r = s.requests.find(r => r.status === 'pending' && r.owner.windowId === context.windowId);
      if (!r) return null;
      // A reopened toolbar has a new document. Replace only a pending claim;
      // the previous document immediately loses all approval authority.
      r.approvalDocumentId = context.documentId;
      return r.id;
    });
  }
  private approval(s: BrokerState, id: string, context: ApprovalIdentity): PendingRequest {
    const r = s.requests.find(r => r.id === id && r.owner.windowId === context.windowId && r.approvalDocumentId === context.documentId);
    if (!r) throw new ProviderError(4100, 'This toolbar popup does not own the request.');
    return r;
  }
  getApproval(id: string, context: ApprovalIdentity): Promise<PendingRequest> {
    return this.serial(async s => this.approval(s, id, context));
  }
  reject(id: string, context: ApprovalIdentity): Promise<void> {
    return this.serial(async s => {
      const r = this.approval(s, id, context);
      if (r.status === 'pending' || r.status === 'signing') rejected(r, 4001, 'The user rejected this wallet request.');
    });
  }
  approveConnection(id: string, context: ApprovalIdentity, account: Connection): Promise<void> {
    this.balanceGeneration++;
    this.balanceReads.clear();
    return this.serial(async s => {
      const r = this.approval(s, id, context);
      if (r.status !== 'pending' || r.args.method !== 'connect') throw new ProviderError(4001, 'This connection request is no longer pending.');
      if (account.accountId !== await this.deps.accountId()) throw new ProviderError(4100, 'The selected account or network changed.');
      s.grants[r.owner.origin] = account; r.account = account; r.status = 'completed'; r.result = [account.address];
      if (s.balances) delete s.balances[r.owner.origin];
    });
  }
  approveBalance(id: string, context: ApprovalIdentity, accountId: string, value: unknown): Promise<void> {
    return this.serial(async s => {
      const generation = this.balanceGeneration;
      const r = this.approval(s, id, context);
      const grant = s.grants[r.owner.origin];
      if (r.status !== 'pending' || r.args.method !== 'getBalance') throw new ProviderError(4001, 'This balance request is no longer awaiting approval.');
      if (!grant || r.account?.accountId !== accountId || grant.accountId !== accountId || r.account.address !== grant.address
        || accountId !== await this.deps.accountId() || generation !== this.balanceGeneration) {
        throw new ProviderError(4100, 'The selected account, network or connection changed.');
      }
      const snapshot = validatePublicBalance(value, this.deps.now());
      if (snapshot.address !== grant.address) throw new ProviderError(4100, 'The balance belongs to a different connection.');
      // Address-only grants, including older versions, acquire this scope only
      // through the authenticated popup's explicit balance approval.
      grant.balanceAccess = true;
      (s.balances ??= {})[r.owner.origin] = snapshot;
      r.status = 'completed'; r.result = snapshot;
    });
  }
  beginSigning(id: string, context: ApprovalIdentity, accountId: string, fee: string): Promise<Payment> {
    return this.serial(async s => {
      const r = this.approval(s, id, context);
      if (r.status !== 'pending' || r.args.method !== 'sendTransaction') throw new ProviderError(4001, 'This payment is no longer awaiting approval.');
      if (r.account?.accountId !== accountId || accountId !== await this.deps.accountId() || s.grants[r.owner.origin]?.accountId !== accountId) throw new ProviderError(4100, 'The selected account, network or connection changed.');
      if (r.expiresAt <= this.deps.now()) throw new ProviderError(4001, 'This wallet request has expired.');
      this.checkPaymentBudget(r.args.params, fee);
      r.status = 'signing'; r.fee = fee;
      return r.args.params!;
    });
  }
  beginBroadcast(id: string, context: ApprovalIdentity, txid: string): Promise<void> {
    this.balanceGeneration++;
    this.balanceReads.clear();
    return this.serial(async s => {
      const r = this.approval(s, id, context);
      if (r.status !== 'signing' || r.account?.accountId !== await this.deps.accountId() || s.grants[r.owner.origin]?.accountId !== r.account?.accountId) throw new ProviderError(4001, 'This payment is no longer authorized for submission.');
      if (r.expiresAt <= this.deps.now()) throw new ProviderError(4001, 'This wallet request has expired.');
      if (r.args.method !== 'sendTransaction' || r.fee === undefined) throw new ProviderError(4001, 'The approved payment is unavailable.');
      this.checkPaymentBudget(r.args.params, r.fee);
      r.status = 'broadcasting'; r.txid = txid;
      s.balances = {};
    });
  }
  private checkPaymentBudget(payment: Payment, fee: string): void {
    if (!/^(0|[1-9][0-9]{0,11})$/.test(fee)) throw new ProviderError(-32602, 'Invalid payment fee.');
    const amount = parsePearlAmount(payment.amount);
    if (amount === null) throw new ProviderError(-32602, 'Invalid payment amount.');
    try {
      const cap = payment.maxTotalDebitAtoms === undefined ? undefined : parseTotalDebitCap(payment.maxTotalDebitAtoms, amount);
      assertTotalDebit(amount, BigInt(fee), cap);
    } catch (error) { throw new ProviderError(-32602, (error as Error).message); }
  }
  finishBroadcast(id: string, confirmed: boolean): Promise<void> {
    return this.serial(async s => {
      const r = s.requests.find(r => r.id === id);
      if (!r || !r.txid || r.status !== 'broadcasting') return;
      if (confirmed) { r.status = 'completed'; r.result = { txid: r.txid }; }
      else { rejected(r, -32002, 'Submission outcome is unknown. Check the transaction ID before taking any further action.'); r.error!.data = { txid: r.txid }; }
    });
  }
  popupClosed(documentId: string): Promise<void> {
    return this.serial(async s => {
      for (const r of s.requests) if (r.approvalDocumentId === documentId) {
        if (r.status === 'pending') delete r.approvalDocumentId;
        if (r.status === 'signing') rejected(r, 4001, 'Signing was interrupted when the toolbar popup closed. No transaction was submitted by this request.');
        // Broadcasts belong to the worker and must not be retried after close.
      }
    });
  }
  windowClosed(windowId: number): Promise<void> {
    return this.serial(async s => { for (const r of s.requests) if (r.owner.windowId === windowId && (r.status === 'pending' || r.status === 'signing')) rejected(r, 4001, 'The requesting browser window was closed.'); });
  }
  documentClosed(tabId: number): Promise<void> {
    return this.serial(async s => {
      for (const r of s.requests) if (r.owner.tabId === tabId && (r.status === 'pending' || r.status === 'signing')) {
        rejected(r, 4001, 'The requesting website was closed or navigated away.');
      }
    });
  }
  sweep(): Promise<void> { return this.serial(async () => {}); }
}
