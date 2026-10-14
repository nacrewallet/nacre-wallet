import shellUrl from '@/assets/nacre-shell.svg';
import { NacreBrand } from '@/ui/NacreBrand';

interface Props { onCreate: () => void; onImport: () => void; }
export function Onboarding({ onCreate, onImport }: Props) {
  return (
    <div className="welcome-screen">
      <div className="welcome-top"><NacreBrand /><span className="network-label">PEARL WALLET</span></div>
      <div className="welcome-art" aria-hidden="true"><img src={shellUrl} alt="" /></div>
      <div className="welcome-copy">
        <h1>Your Pearl.<br />Close at hand.</h1>
        <p>A quiet home for your PRL.<br />Your keys. Your wallet. Your way.</p>
      </div>
      <div className="welcome-actions">
        <button onClick={onCreate} className="pearl-btn">Create a wallet</button>
        <button onClick={onImport} className="nacre-btn-secondary">I already have a wallet</button>
      </div>
      <p className="welcome-note">Self-custody on the Pearl network</p>
    </div>
  );
}