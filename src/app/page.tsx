import { M4Preview } from './m4-preview';
import { M5Preview } from './m5-preview';
import { CircuitCanvas } from '@/canvas/circuit-canvas';
import { ProtocolPlayer } from '@/player/protocol-player';
import { ZkPanel } from './zk-panel';

// The complete pipeline/canvas/inspector layout lands at M6–M7.
// The M4 preview remains deliberately labelled unsound-alone for comparison.
export default function Home() {
  return (
    <main className="scaffold">
      <svg viewBox="0 0 32 32" width="56" height="56" aria-hidden>
        <circle cx="16" cy="16" r="11" stroke="var(--accent)" strokeWidth="2.5" fill="none" />
        <circle cx="16" cy="16" r="4" fill="var(--accent)" />
      </svg>
      <h1>Witness List</h1>
      <p>Build a claim, prove it, try to cheat.</p>
      <p className="mono">
        v0.1.10 — a teaching-scale DEEP/FRI kernel is locally verified. The full player,
        canvas, sharing, and integrated ZK mode remain under construction.
      </p>
      <M5Preview />
      <CircuitCanvas />
      <ProtocolPlayer />
      <ZkPanel />
      <M4Preview />
    </main>
  );
}
