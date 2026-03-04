# Witness List

**Build a claim, prove it, try to cheat.**

In a trial, the *witness list* is the roster of testimony the parties will offer. In a zero-knowledge proof, the *witness* is the private input — the thing you know but won't reveal. Witness List is the workshop for both meanings: build a claim, put it on the stand, cross-examine it.

A zero-knowledge proof workshop that runs entirely in your browser. Write a bounded Witness Script or choose a visual preset, compile it to PLONK constraints, and run a teaching-scale Fp² DEEP/FRI proof through all seven verifier checks. The app includes protocol-bound Plookup ranges, a tagged-multiset 9×9 Sudoku, blinded proofs, optional transcript-bound grinding work, a circuit workbench, a worker-backed 16-stage replay player, ten guided lessons, an attack lab, and verify-only proof URLs that preserve canonical script provenance. Its no-witness transcript panel remains explicitly an illustration, not a formal simulator proof.

Then the part nothing else lets you do: **tamper with the witness and watch the exact equation that catches you.** Change one Sudoku cell. The constraint polynomial stops vanishing on the trace domain, the quotient stops being a polynomial, and the verifier's identity check fails — at a specific row, with specific numbers, highlighted in red.

ZK today is either hand-wavy cave metaphors or production libraries with opaque internals. Witness List is the missing middle: **a real transparent proof system with glass walls.**

## Implemented build surface

- **Prove** — five preset claims with structured inputs (4×4 and multiset-backed 9×9 Sudoku grids, a hash preimage, a lookup-ranged age slider, and a Pythagorean triple), or wire up your own circuit from the gate palette.
- **Step through** — a 16-stage player from circuit to verifier checklist. The grand-product copy-constraint argument telescopes to 1 before your eyes. FRI folds halve the degree card by card.
- **Cheat** — a first-class attack lab: tamper the witness (caught by the quotient identity), edit a committed leaf (caught by a Merkle path), or grind challenges against a weakened verifier (caught by statistics — with a live attempt counter showing you what "security bits" buys).
- **See the zero** — a ZK tab with a ledger of every byte the verifier receives, and a side-by-side simulated transcript generated *without* the witness.
- **Share proofs** — the URL carries circuit, public inputs, and proof; the recipient's browser verifies locally. No accounts, no server.
- **Author claims** — CodeMirror-backed Witness Script provides syntax highlighting, compile-on-idle diagnostics, canonical formatting, bounded loops/ranges, and MiMC/Poseidon/Merkle standard-library calls.
- **Learn the arc** — ten locally persisted lessons, a proof-size breakdown, a 200-replay blinding histogram, and an optional Poseidon Merkle tree make the later protocol ideas inspectable too.

## Honesty, stated plainly

The implemented proof path is a genuine PLONK-arithmetized, FRI-committed teaching system — not production cryptography. Protocol wire v2 samples β, γ, α, ζ, ρ, and FRI fold challenges in Fp²; binds sorted-concatenation Plookup membership; and supports tagged multiset grand products. It still uses deliberately modest parameters (up to 32 queries) with **conjectured** soundness at the displayed bounds. The M4-only lesson remains deliberately marked **unsound alone** and is never accepted by the full verifier; protocol-v1 proof links remain readable for compatibility.

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # algebra laws, protocol gates, negative (attack) suite
npm run build      # static export in out/
```

Requires Node 22+. `tools/reference.py` is an independent Python implementation of the field, NTT, MiMC, and workshop Poseidon parameterization used to cross-check fixtures.

## Deploy

Static and client-side — proving and verifying happen in the visitor's browser. Both pipelines are committed:

- **GitHub Pages** — push to `main`; `.github/workflows/ci.yml` builds and deploys (enable Pages → Source: GitHub Actions once).
- **GitLab Pages** — push to `main`; `.gitlab-ci.yml` builds and publishes automatically.

Both set `BASE_PATH` for project-site subpaths; for a custom domain or root site, set it to `''` in the pipeline. Or `npm run build` and drop `out/` on any static host.

## Stack

Next.js (static export) · React 19 · TypeScript (strict) · React Flow (circuit canvas) · CodeMirror 6 (Witness Script editor). The protocol kernel (`src/zk/`) is **dependency-free, hand-rolled TypeScript**: Goldilocks/Fp² arithmetic on BigInt, radix-2 NTT, SHA-256 and workshop Poseidon trees, PLONK copy/lookup grand products, and Fp² DEEP-FRI. The prover runs in a Web Worker and emits a full trace — which is what makes every step inspectable.

## Status & plan

The local build is code-complete against the three-phase plan. Phase 2's extension-field protocol, Plookup/range/9×9 bundle, Poseidon, grinding deterrent, course mode, and proof-size/performance work are implemented; Phase 3's language, compiler, editor, scriptable gallery, provenance migration, sharing, and course polish are implemented. Remaining work is owner-only (audit, usability, browser perf, deploy/publish).

## License

MIT — see [LICENSE](./LICENSE).

## AI Agent Instructions

Before making any new commits, update the **Product Version** string below in this file with the current IST time of commit (`Asia/Kolkata`). Keep the same numeric release version in `package.json` and the root package entries of `package-lock.json` (once `package.json` exists — from P0 on).

This IST timestamp rule is permanent for all future workflows, commits, and AI agents working in this repository.

Follow this format for version control:

* **Base Format Version:** 0.0.0 — the version of the version-block schema itself (the shape of these lines).
* **Product Version:** `v0.4.1_2026-03-04_22:10:08` (IST)
