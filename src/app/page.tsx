import { IdentityPreview } from './identity-preview';
import { Workshop } from './workshop';

// The identity-only preview remains deliberately labelled unsound-alone for comparison.
export default function Home() {
  return (
    <main>
      <Workshop />
      <section className="identity-reference">
        <p className="eyebrow">Algebra-only reference</p>
        <p>
          The identity-only lesson remains <strong>unsound alone</strong>. The full workshop uses
          the DEEP/FRI path and V1–V7; this separate reference never substitutes for verification.
        </p>
      </section>
      <IdentityPreview />
    </main>
  );
}
