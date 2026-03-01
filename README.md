# Witness List

**Build a claim, prove it, try to cheat.**

In a trial, the *witness list* is the roster of testimony the parties will offer. In a zero-knowledge proof, the *witness* is the private input — the thing you know but won't reveal. Witness List is the workshop for both meanings: build a claim, put it on the stand, cross-examine it.

A zero-knowledge proof workshop that runs entirely in your browser. Express a claim — *"I know this Sudoku's solution"*, *"I know the preimage of this hash"*, *"I'm over 18"* — as an arithmetic circuit on a canvas. Watch it compile to PLONK constraints. Then run the full protocol for real: polynomial commitments, Fiat–Shamir challenges, FRI low-degree testing — with every polynomial, Merkle tree, and transcript byte inspectable.

Then the part nothing else lets you do: **tamper with the witness and watch the exact equation that catches you.** Change one Sudoku cell. The constraint polynomial stops vanishing on the trace domain, the quotient stops being a polynomial, and the verifier's identity check fails — at a specific row, with specific numbers, highlighted in red.

ZK today is either hand-wavy cave metaphors or production libraries with opaque internals. Witness List is the missing middle: **a real transparent proof system with glass walls.**

## What you can do

- **Prove** — four preset claims with structured inputs (a 4×4 Sudoku grid, a hash preimage, an age slider, a Pythagorean triple), or wire up your own circuit from the gate palette.
- **Step through** — a 16-stage player from circuit to verifier checklist. The grand-product copy-constraint argument telescopes to 1 before your eyes. FRI folds halve the degree card by card.
- **Cheat** — a first-class attack lab: tamper the witness (caught by the quotient identity), edit a committed leaf (caught by a Merkle path), or grind challenges against a weakened verifier (caught by statistics — with a live attempt counter showing you what "security bits" buys).
- **See the zero** — a ZK tab with a ledger of every byte the verifier receives, and a side-by-side simulated transcript generated *without* the witness.
- **Share proofs** — the URL carries circuit, public inputs, and proof; the recipient's browser verifies locally. No accounts, no server.

## Honesty, stated plainly

This is a genuine PLONK-arithmetized, FRI-committed proof system — and a teaching instrument, not production cryptography. It runs at deliberately modest parameters (64-bit Goldilocks field, base-field challenges, 32 queries ≈ **2⁻⁵⁰ conjectured soundness**), and it *shows you* that number, live, with the formula. Production systems get ~2⁻¹⁰⁰ by sampling challenges from extension fields; that's the first item on the roadmap. What's real is the structure — and the negative test suite: every attack the app demos is an attack CI proves gets caught.

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # algebra laws, protocol gates, negative (attack) suite
npm run build      # static export in out/
```

Requires Node 22+. `tools/reference.py` is an independent Python implementation of the field, NTT, and MiMC used to cross-check fixtures.

## Deploy

Static and client-side — proving and verifying happen in the visitor's browser. Both pipelines are committed:

- **GitHub Pages** — push to `main`; `.github/workflows/ci.yml` builds and deploys (enable Pages → Source: GitHub Actions once).
- **GitLab Pages** — push to `main`; `.gitlab-ci.yml` builds and publishes automatically.

Both set `BASE_PATH` for project-site subpaths; for a custom domain or root site, set it to `''` in the pipeline. Or `npm run build` and drop `out/` on any static host.

## Stack

Next.js (static export) · React 19 · TypeScript (strict) · Zustand · React Flow (circuit canvas). The protocol kernel (`src/zk/`) is **dependency-free, hand-rolled TypeScript**: Goldilocks field arithmetic on BigInt, radix-2 NTT, SHA-256 Merkle trees, PLONK permutation argument, DEEP-FRI. The prover runs in a Web Worker and emits a full trace — which is what makes every step inspectable.

## Status & plan

This repo is the build plan plus a compiling scaffold (the field layer is implemented and tested against independently computed vectors). It's a three-phase program (~6 months): **Phase 1** ships the workshop above; **Phase 2** adds extension-field challenges (~2⁻¹⁰⁰ soundness), a lookup argument with range gates and 9×9 Sudoku, Poseidon, and a guided course mode; **Phase 3** adds **Witness Script** — a tiny claim language that compiles to circuits, capped by a Merkle-membership proof.

## License

MIT — see [LICENSE](./LICENSE).

## AI Agent Instructions

Before making any new commits, update the **Product Version** string below in this file with the current IST time of commit (`Asia/Kolkata`). Keep the same numeric release version in `package.json` and the root package entries of `package-lock.json` (once `package.json` exists — from P0 on).

This IST timestamp rule is permanent for all future workflows, commits, and AI agents working in this repository.

Follow this format for version control:

* **Base Format Version:** 0.0.0 — the version of the version-block schema itself (the shape of these lines).
* **Product Version:** `v0.2.2_2026-03-02_00:49:14` (IST)
