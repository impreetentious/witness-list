// v0 scaffold shell. Replaced by the pipeline/canvas/inspector layout at M6–M7.
// Interactive surfaces become client components ('use client');
// the zk/ kernel stays framework-free.
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
        v0 scaffold — field kernel implemented, gates in
        src/zk/__tests__/
      </p>
    </main>
  );
}
