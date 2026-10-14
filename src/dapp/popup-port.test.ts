import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintainPopupPort } from './popup-port';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('toolbar lifetime tracking', () => {
  it('heartbeats, reconnects an interrupted worker port, and never reconnects after UI cleanup', () => {
    vi.useFakeTimers();
    const ports: Array<{ postMessage: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onDisconnect: { addListener(listener: () => void): void }; lose: () => void }> = [];
    const connect = vi.fn(() => {
      let lost = () => {};
      const port = { postMessage: vi.fn(), disconnect: vi.fn(() => lost()), onDisconnect: { addListener: (listener: () => void) => { lost = listener; } }, lose: () => lost() };
      ports.push(port);
      return port;
    });
    vi.stubGlobal('chrome', { runtime: { connect } });
    const stop = maintainPopupPort();
    expect(connect).toHaveBeenCalledWith({ name: 'popup' });
    vi.advanceTimersByTime(20_000);
    expect(ports[0].postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    ports[0].lose();
    vi.advanceTimersByTime(500);
    expect(connect).toHaveBeenCalledTimes(2);
    ports[0].lose(); // A stale disconnect must not spawn an additional port.
    vi.advanceTimersByTime(500);
    expect(connect).toHaveBeenCalledTimes(2);
    stop();
    expect(ports[1].disconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ports[1].postMessage).not.toHaveBeenCalled();
  });
});
