import { M4Preview } from './m4-preview';
import { Workshop } from './workshop';

// The M4 preview remains deliberately labelled unsound-alone for comparison.
export default function Home() {
  return (
    <main>
      <Workshop />
      <section className="m4-reference">
        <p className="eyebrow">M4 algebra-only reference</p>
        <p>
          The M4 identity lesson remains <strong>unsound alone</strong>. The full workshop uses the
          DEEP/FRI path and V1–V7; this separate reference never substitutes for verification.
        </p>
      </section>
      <M4Preview />
    </main>
  );
}
