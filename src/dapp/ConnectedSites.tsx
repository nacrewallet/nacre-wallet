import { useEffect, useState } from 'react';
export function ConnectedSites() {
  const nativeOnly = chrome.runtime.getURL('').startsWith('moz-extension:');
  const [sites, setSites] = useState<Array<{ origin: string; address: string }>>([]);
  const [error, setError] = useState('');
  async function refresh() {
    const result = await chrome.runtime.sendMessage({ type: 'nacre:connections', action: 'list' });
    if (!result?.ok) throw new Error('Could not load connected sites.');
    setSites(result.value);
  }
  useEffect(() => { if (!nativeOnly) void refresh().catch(() => setError('Connected sites are unavailable.')); }, [nativeOnly]);
  async function revoke(origin: string) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'nacre:connections', action: 'revoke', origin });
      if (!result?.ok) throw new Error();
      await refresh(); setError('');
    } catch { setError('The connection could not be removed.'); }
  }
  if (nativeOnly) return <section className="space-y-3" aria-label="Connected sites"><h2 className="text-sm font-semibold">Connected sites</h2><p className="text-xs text-pearl-400">Website connections are currently available in Chromium browsers. This Firefox build supports native wallet features only.</p></section>;
  return <section className="space-y-3" aria-label="Connected sites">
    <h2 className="text-sm font-semibold">Connected sites</h2>
    <p className="text-xs text-pearl-400">Connections last for this browser session. Every payment needs a separate approval.</p>
    {sites.length === 0 && !error && <p className="text-xs text-pearl-400">No sites connected to this account.</p>}
    {sites.map(site => <div className="rounded-xl border border-ink-600 p-3 space-y-2" key={site.origin}><p className="text-xs break-all">{site.origin}</p><p className="text-[10px] text-pearl-400 break-all">{site.address}</p><button className="nacre-btn-secondary min-h-11 w-full" onClick={() => void revoke(site.origin)}>Disconnect</button></div>)}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </section>;
}
