'use client';

import type { Params } from '@/zk/types';

export function SecurityReadout({ params }: { params: Params }) {
  const ldeSize = params.n * params.blowup;
  const zetaBits = (64 - Math.log2(3 * params.n)).toFixed(1);
  const friBits = params.queries * Math.log2(params.blowup);
  return (
    <aside className="security-readout" aria-label="Teaching-scale security readout">
      <p className="eyebrow">Live security readout</p>
      <p><strong>Conjectured teaching-scale bound</strong> — not a production-security claim.</p>
      <code>ε ≈ max(3n / (p − |D|), (1/{params.blowup})^{params.queries}, 2⁻³²)</code>
      <dl>
        <div><dt>trace / LDE</dt><dd>n = {params.n}; |D| = {ldeSize}</dd></div>
        <div><dt>ζ identity term</dt><dd>about 2⁻{zetaBits}</dd></div>
        <div><dt>FRI query term</dt><dd>about 2⁻{friBits}</dd></div>
        <div><dt>index bias</dt><dd>at most 2⁻³² per index</dd></div>
      </dl>
      <p className="mono">Production systems sample challenges from an extension field and add anti-grinding measures. This build teaches the base-field structure honestly.</p>
    </aside>
  );
}
