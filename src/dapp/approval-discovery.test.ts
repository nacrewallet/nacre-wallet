import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchApproval } from './approval-discovery';

afterEach(() => { vi.useRealTimers(); });

function pendingClaim() {
  let resolve!: (id: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('toolbar approval discovery', () => {
  it('surfaces a startup error and retries to recover the queued request', async () => {
    vi.useFakeTimers();
    const startupError = new Error('The wallet worker is starting.');
    const claim = vi.fn<() => Promise<string | null>>().mockRejectedValueOnce(startupError).mockResolvedValue('queued-request');
    const onClaim = vi.fn();
    const onError = vi.fn();
    watchApproval({ claim, onClaim, onError, focusTarget: new EventTarget() });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenLastCalledWith(startupError);
    expect(onClaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onClaim).toHaveBeenCalledExactlyOnceWith('queued-request');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finds a request submitted after the toolbar is already open', async () => {
    vi.useFakeTimers();
    const claim = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('late-request');
    const onClaim = vi.fn();
    watchApproval({ claim, onClaim, onError: vi.fn(), focusTarget: new EventTarget() });
    await vi.advanceTimersByTimeAsync(0);
    expect(onClaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onClaim).toHaveBeenCalledExactlyOnceWith('late-request');
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('checks immediately on focus or manual retry without accumulating timers', async () => {
    vi.useFakeTimers();
    const focusTarget = new EventTarget();
    const claim = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const discovery = watchApproval({ claim, onClaim: vi.fn(), onError: vi.fn(), focusTarget });
    await vi.advanceTimersByTimeAsync(0);
    focusTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    discovery.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    discovery.stop();
  });

  it('keeps a single request in flight across focus, retry and elapsed intervals', async () => {
    vi.useFakeTimers();
    const deferred = pendingClaim();
    const focusTarget = new EventTarget();
    const claim = vi.fn(() => deferred.promise);
    const onClaim = vi.fn();
    const discovery = watchApproval({ claim, onClaim, onError: vi.fn(), focusTarget });
    discovery.retry();
    focusTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claim).toHaveBeenCalledOnce();
    deferred.resolve('one-request');
    await vi.advanceTimersByTimeAsync(0);
    expect(onClaim).toHaveBeenCalledExactlyOnceWith('one-request');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never discovers again after claiming, so onboarding and signing retain the same request', async () => {
    vi.useFakeTimers();
    const focusTarget = new EventTarget();
    const removeListener = vi.spyOn(focusTarget, 'removeEventListener');
    const claim = vi.fn<() => Promise<string | null>>().mockResolvedValue('approval-to-keep');
    const onClaim = vi.fn();
    const discovery = watchApproval({ claim, onClaim, onError: vi.fn(), focusTarget });
    await vi.advanceTimersByTimeAsync(0);
    discovery.retry();
    focusTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claim).toHaveBeenCalledOnce();
    expect(onClaim).toHaveBeenCalledExactlyOnceWith('approval-to-keep');
    expect(removeListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its timer and focus listener on unmount', async () => {
    vi.useFakeTimers();
    const focusTarget = new EventTarget();
    const claim = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const discovery = watchApproval({ claim, onClaim: vi.fn(), onError: vi.fn(), focusTarget });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    discovery.stop();
    expect(vi.getTimerCount()).toBe(0);
    discovery.retry();
    focusTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claim).toHaveBeenCalledOnce();
  });

  it.each(['success', 'failure'] as const)('ignores a late %s after disposal', async (outcome) => {
    vi.useFakeTimers();
    const deferred = pendingClaim();
    const onClaim = vi.fn();
    const onError = vi.fn();
    const discovery = watchApproval({ claim: () => deferred.promise, onClaim, onError, focusTarget: new EventTarget() });
    discovery.stop();
    if (outcome === 'success') deferred.resolve('old-document-claim');
    else deferred.reject(new Error('Old worker response.'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onClaim).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
