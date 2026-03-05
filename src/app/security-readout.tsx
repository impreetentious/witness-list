'use client';

import type { Params } from '@/zk/types';

export function SecurityReadout({ params }: { params: Params }) {
  const ldeSize = params.n * params.blowup;
  const zetaBits = (128 - Math.log2(3 * params.n)).toFixed(1);
  const friBits = params.queries * Math.log2(params.blowup);
  const grindingBits = params.grindingBits ?? 0;
  return (
    <aside className="security-readout" aria-label="Teaching-scale security readout">
      <p className="eyebrow">Live security readout</p>
      <p>
        <strong>Conjectured teaching-scale bound</strong> — not a production-security claim.
      </p>
      <code>
        ε ≈ max(3n / (p² − |D|), (1/{params.blowup})^{params.queries}, 2⁻³²)
      </code>
      <dl>
        <div>
          <dt>trace / LDE</dt>
          <dd>
            n = {params.n}; |D| = {ldeSize}
          </dd>
        </div>
        <div>
          <dt>ζ identity term</dt>
          <dd>about 2⁻{zetaBits}</dd>
        </div>
        <div>
          <dt>FRI query term</dt>
          <dd>about 2⁻{friBits}</dd>
        </div>
        <div>
          <dt>challenge grinding</dt>
          <dd>{grindingBits === 0 ? 'off' : `2⁻${grindingBits} post-commitment work per proof`}</dd>
        </div>
        <div>
          <dt>index bias</dt>
          <dd>at most 2⁻³² per index</dd>
        </div>
      </dl>
      <p className="mono">
        This build samples β, γ, α, ζ, ρ and every FRI fold challenge in Fp², and exposes an
        optional SHA-256 work factor before query derivation. The combined estimate remains
        teaching-scale and conjectured, not a production-security claim.
      </p>
    </aside>
  );
}
