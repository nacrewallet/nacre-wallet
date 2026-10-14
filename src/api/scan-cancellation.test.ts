import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanAddresses as pearlScan } from './pearlchain';
import { scanAddresses as blockbookScan } from './blockbook';

describe('whole-scan cancellation reaches stalled explorer bodies', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([['Pearlchain', pearlScan], ['Blockbook', blockbookScan]] as const)('%s stops reading a body when the caller scan deadline expires', async (_name, scan) => {
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        bodyStarted(); signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      }) };
    }));
    const controller = new AbortController();
    const result = scan('https://fixture.invalid', ['fixture-address'], controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
});
