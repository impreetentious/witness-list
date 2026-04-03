# Witness List

**Build a claim, prove it, try to cheat.**

In a trial, the _witness list_ is the roster of testimony the parties will offer. In a zero-knowledge proof, the _witness_ is the private input — the thing you know but won't reveal. Witness List is the workshop for both meanings: build a claim, put it on the stand, cross-examine it.

A zero-knowledge proof workshop that runs entirely in your browser. Write a bounded Witness Script or choose a visual preset, compile it to PLONK constraints, and run a teaching-scale Fp² DEEP/FRI proof through all seven verifier checks. The app includes protocol-bound Plookup ranges, a tagged-multiset 9×9 Sudoku, blinded proofs, optional transcript-bound grinding work, a circuit workbench, a worker-backed 16-stage replay player, ten guided lessons, an attack lab, and verify-only proof URLs that preserve canonical script provenance.

Then the part nothing else lets you do: **tamper with the witness and watch the exact equation that catches you.** Change one Sudoku cell. The constraint polynomial stops vanishing on the trace domain, the quotient stops being a polynomial, and the verifier's identity check fails — at a specific row, with specific numbers, highlighted in red.

ZK today is either hand-wavy cave metaphors or production libraries with opaque internals. Witness List is the missing middle: **a real transparent proof system with glass walls.**

## What you can do

- **Prove** — five preset claims with structured inputs (4×4 and multiset-backed 9×9 Sudoku grids, a hash preimage, a lookup-ranged age slider, and a Pythagorean triple), or wire up your own circuit from the gate palette.
- **Step through** — a 16-stage player from circuit to verifier checklist. The grand-product copy-constraint argument telescopes to 1 before your eyes. FRI folds halve the degree card by card.
- **Cheat** — a first-class attack lab: tamper the witness (caught by the quotient identity), edit a committed leaf (caught by a Merkle path), or grind challenges against a weakened verifier (caught by statistics — with a live attempt counter showing you what "security bits" buys).
- **See the zero** — a ZK tab with a ledger of every byte the verifier receives, and a side-by-side simulated transcript generated _without_ the witness.
- **Share proofs** — the URL carries circuit, public inputs, and proof; the recipient's browser verifies locally. No accounts, no server.
- **Author claims** — CodeMirror-backed Witness Script provides syntax highlighting, compile-on-idle diagnostics, canonical formatting, bounded loops/ranges, and MiMC/Poseidon/Merkle standard-library calls.
- **Learn the arc** — ten locally persisted lessons, a proof-size breakdown, a 200-replay blinding histogram, and an optional Poseidon Merkle tree make the later protocol ideas inspectable too.

## Honesty, stated plainly

The implemented proof path is a genuine PLONK-arithmetized, FRI-committed teaching system — **not production cryptography.** Protocol wire v2 samples β, γ, α, ζ, ρ, and FRI fold challenges in Fp²; binds sorted-concatenation Plookup membership; and supports tagged multiset grand products. It still uses deliberately modest parameters (up to 32 queries) with **conjectured** soundness at the displayed bounds, and the app computes and shows its own security estimate rather than asserting one.

Other boundaries, stated in the product as well as here:

- The no-witness transcript panel is explicitly an illustration, not a formal simulator proof.
- One lesson deliberately stops at the polynomial-identity check, without the FRI low-degree test. It is labelled **unsound alone** and is never accepted by the full verifier.
- No pairings, KZG or Groth16; no recursion or aggregation; no custom gates; circuits are bounded to roughly 2¹² rows.
- Protocol-v1 proof links remain readable for compatibility.

## Run it

Requires Node 22+, and a browser with BigInt and Web Workers — the prover runs off the main thread.

```bash
npm install
npm run dev        # local dev server on http://localhost:3000
```

## Verify

```bash
npm run typecheck
npm test           # algebra laws, protocol gates, negative (attack) suite
npm run lint
npm run format:check
npm run build      # static export in out/
```

The negative suite is the load-bearing one: every canned attack in the app is the same function the tests run, so a soundness regression fails CI rather than quietly shipping. `tools/reference.py` is an independent Python implementation of the field, NTT, MiMC, and workshop Poseidon parameterization used to cross-check fixtures.

## Deploy

Static and client-side — proving and verifying happen in the visitor's browser. Nothing is deployed yet; both pipelines are committed and ready:

- **GitHub Pages** — push to `main`; `.github/workflows/ci.yml` builds and deploys (enable Pages → Source: GitHub Actions once).
- **GitLab Pages** — `.gitlab-ci.yml` builds and publishes on push to `main`. It is an unused mirror today: the repository has no GitLab remote, so this pipeline only becomes live once a GitLab project exists and is added as a remote.

Both set `BASE_PATH` for project-site subpaths; for a custom domain or root site, set it to `''` in the pipeline. Or `npm run build` and drop `out/` on any static host.

## Stack

Next.js (static export) · React 19 · TypeScript (strict) · React Flow (circuit canvas) · CodeMirror 6 (Witness Script editor). The protocol kernel (`src/zk/`) is **dependency-free, hand-rolled TypeScript**: Goldilocks/Fp² arithmetic on BigInt, radix-2 NTT, SHA-256 and workshop Poseidon trees, PLONK copy/lookup grand products, and Fp² DEEP-FRI. The prover runs in a Web Worker and emits a full trace — which is what makes every step inspectable.

## License

MIT — see [LICENSE](./LICENSE).

---

**Version:** v0.8.0
