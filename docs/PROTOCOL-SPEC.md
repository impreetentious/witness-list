# Witness List — Protocol Specification

The normative specification for this repository: the architecture boundaries, the PLONK
protocol and its algebra, the circuit IR, the UI contract, the presets, the worker and
serialization formats, the honesty gates, the decision log, and the verified constants and
fixtures.

**This document is authoritative.** Source comments cite it by section number. The security
readout, transcript, and gate numbering used in code all resolve here; changes to either side must
keep the implementation, tests, and specification aligned.

Scope note: this is a **teaching-scale** implementation. The parameters, field sizes, and
query counts are chosen to be inspectable, not to be production-secure. Nothing here should be
read as a claim of production cryptographic strength.

---

## 3. Architecture

**Stack:** Next.js 16 (App Router, `output: 'export'` — fully static) + React 19 + TypeScript (strict) + @xyflow/react (React Flow) for the circuit canvas + CodeMirror 6 for Witness Script editing. Prover runs in a Web Worker (`new Worker(new URL('./prover.worker.ts', import.meta.url))` — bundled natively by Next; hand-rolled postMessage protocol with structured-clone `ProofTrace` payloads). Tests: Vitest + fast-check (standalone `vitest.config.ts`, independent of Next's bundler). Lint: oxlint plus `check:gates`. Deploy: equivalent GitHub Pages and GitLab Pages pipelines. **The `src/zk/` package has zero dependencies** — every field op, hash-tree, and FRI fold is in this repo. React Flow and CodeMirror are UI-only; the language compiler and protocol kernel remain dependency-free and node-testable (decision log §12).

Next.js notes (see §12): SSR is intentionally unused — the whole point is that proving and verifying happen in the visitor's browser. Interactive surfaces are `'use client'` components; the app exports to static files in `out/`. Subpath hosting uses the `BASE_PATH` environment variable (empty for custom domains). `next build` type-checks the whole project; CI also runs an explicit `npm run typecheck` before build. The `src/zk/` kernel and its tests are bundler-agnostic.

**Module map** (`src/`):

```
app/               Next.js shell and interactive workshop panels
canvas/            React Flow circuit workbench
course/            guided lesson data
player/            16-stage replay and proof inspectors
script/            Witness Script parser, formatter, compiler, and gallery
share/             versioned proof + circuit + provenance URL codec
workers/           prover/grinding Web Worker boundary
zk/                pure, DOM-free, deterministic — the protocol kernel (`src/zk/`)
  field.ts         Goldilocks arithmetic
  poly.ts          coeff-form ops: add/mul/div-with-remainder, vanishing poly, Lagrange/barycentric
  ntt.ts           radix-2 NTT/iNTT, coset LDE (blowup 8)
  merkle.ts        SHA-256 Merkle tree, paths, batched opening
  transcript.ts    Fiat–Shamir: absorb/squeeze with domain-separated labels, replayable log
  circuit/
    ir.ts          circuit graph types (gates, wires) + validation
    compile.ts     graph -> PLONK rows (a,b,c, selectors, σ permutation), witness gen
    presets/       builder.ts, pythagorean.ts, sudoku.ts, sudoku9.ts, mimc.ts, age.ts
  plonk/
    params.ts      the supported teaching-scale parameter range (§4.11)
    chunks.ts      quotient chunk layout and FRI degree bound shared by both wires
    arithmetic.ts  selector/σ polynomials, PI(ζ), and ζ-domain predicates
    permutation.ts grand-product Z construction + σ polynomials (wire v1)
    quotient.ts    constraint composition C(x), division by Z_H, chunk split (wire v1)
    prove.ts       wire dispatch + the compatibility v1 and identity-only provers
    verify.ts      wire dispatch + the compatibility v1 verifier (§4.8)
    permutation-fp2.ts, quotient-fp2.ts  the shipped wire-v2 copy and constraint arguments
    lookup.ts      Plookup membership and tagged-multiset grand products (wire v2)
    prove-fp2.ts   the shipped prover: Fp² challenges, Plookup, Fp² DEEP-FRI (§4.6)
    verify-fp2.ts  the shipped checklist verifier for wire v2 (§4.8)
  fri/fri.ts       batch DEEP-FRI: fold, commit, query, verify (wire v1)
  fri/fri-fp2.ts   the shipped Fp² DEEP-FRI cascade (§4.7)
  types.ts         Proof / ProofV1 / ProofTrace wire and player payload types
  fp2.ts           quadratic-extension arithmetic used by protocol wire v2
  fp2-poly.ts      extension-valued polynomial operations and off-domain evaluation
  poseidon.ts      reproducible teaching parameterization + vectors
  poseidon-merkle.ts optional field Merkle tree — a Z16 kernel component, off the proof path
  grinding.ts      transcript-bound SHA-256 work nonce
  attacks.ts       the three canned malicious provers (first-class, shared with CI)
  zkmode.ts        blinding insertion + transcript illustration
```

**Data flow:** canvas graph (or preset) → `compile.ts` → `CompiledCircuit` (rows, selectors, σ) → witness gen from structured inputs → prover (worker) emits a **`ProofTrace`**: the proof plus the bounded intermediate payloads and transcript log that the player and inspectors render. The verifier consumes only the lean `Proof` — the separation _is_ the pedagogy (a "what the verifier actually sees" toggle greys out everything not in the `Proof`).

**Determinism:** the only randomness is the prover's blinding, drawn from a seeded PRNG (mulberry32 over 64-bit lanes via two calls). Same seed ⇒ byte-identical proof, which supports repeatable player traces and the golden-transcript gate (§9). Shared verify-only URLs carry the resulting proof, not prover randomness.

**Performance budgets:** both Sudoku presets compile to n = 2⁹ rows (LDE 2¹²); proving stays worker-side and the main-thread trace table is windowed above 128 rows. BigInt/NTT throughput is covered by the NTT benchmark and browser performance tests. CI measures regressions in a controlled browser run, while real-device timing still depends on the visitor's hardware.

---

## 4. Protocol spec (the math)

### 4.1 Field

p = 2⁶⁴ − 2³² + 1 = 18446744069414584321 (Goldilocks). p − 1 = 2³² · 3 · 5 · 17 · 257 · 65537, so 2-adicity 32. Generator g = 7 (verified primitive). Subgroup generator for size 2^k domains: ω_k = 7^((p−1)/2^k). All verified; test vectors in §13.

Facts the code must respect:

- gcd(3, p−1) = 3 ⇒ **x³ is NOT a permutation** of F_p. gcd(7, p−1) = 1 ⇒ **x⁷ is** — hence MiMC uses exponent 7 (§7.3). This is exactly the kind of trap a from-scratch build must not fall into.
- 7 is a quadratic non-residue ⇒ x² − 7 is irreducible ⇒ protocol-v2's `F_p[x]/(x²−7)` challenge field is well-defined.

`field.ts` API: `mod/add/sub/mul/neg/inv/pow/twoAdicRoot(k)/batchInverse`. Inversion via Fermat (x^(p−2)). `batchInverse` is the amortized Montgomery-trick form; the prover and verifier invert pointwise today, so it is a gate-tested utility rather than a hot-path dependency.

### 4.2 Domains

Trace domain H = ⟨ω⟩ of size n (power of two, per circuit; presets are 2⁵–2⁹). Evaluation domain D = g·⟨ω'⟩ of size 8n (**coset** — shifted by the generator so D ∩ H = ∅; consequences: Z_H never vanishes on D, and query openings never reveal on-trace values, which the ZK argument needs). Vanishing polynomial Z_H(x) = xⁿ − 1; on the coset, Z_H(g·ω'^i) = gⁿ·ω'^(ni) − 1, computable in O(1) per point. Lagrange basis at ζ via barycentric form: L_i(ζ) = (ω^i / n) · (ζⁿ − 1)/(ζ − ω^i).

### 4.3 Arithmetization (PLONK)

Per row j: wire values a_j, b_j, c_j and selectors q_L, q_R, q_O, q_M, q_C. Gate identity on H:

```
q_L·a + q_R·b + q_O·c + q_M·a·b + q_C + PI(x) = 0
```

Conventions: an arithmetic gate computing `out = l + r` sets q\_L=q\_R=1, q\_O=−1; `out = l·r` sets q\_M=1, q\_O=−1; constants via q\_C; assert-zero via q\_L=1 with b,c unused. Public inputs occupy the first ℓ rows with q\_L=1, all other selectors 0, and PI(X) = Σ\_{i<ℓ} −pi\_i·L\_i(X) (verifier recomputes PI(ζ) barycentrically — it is _their_ data, not the prover's).

**Copy constraints.** Slot index space: a-slots are H, b-slots k₁·H, c-slots k₂·H with k₁ = 7, k₂ = 49 (7 has order p−1 > n, so the three cosets are disjoint). σ: slot → slot is the permutation induced by "same wire" classes from the circuit graph. Identity polynomial id(x) = x on each coset; σ encoded as three polynomials S_a, S_b, S_c over H.

**Grand product** (protocol-v2 challenges β, γ ∈ Fp²; base values embed as `(x,0)`):

```
Z(1) = 1
Z(ω·x) = Z(x) · Π_{s∈{a,b,c}}  (w_s(x) + β·id_s(x) + γ) / (w_s(x) + β·S_s(x) + γ)
```

If σ maps wire values consistently, the product telescopes to 1 around H. Two constraints:

- transition: `Z(x)·f(x) − Z(ω·x)·f'(x) = 0` on H (f, f' the numerator/denominator products),
- boundary: `L_1(x)·(Z(x) − 1) = 0` on H.

**The UI renders the running product literally** — a column of partial products visibly collapsing to 1.

**Lookup arguments.** A membership circuit commits Plookup's alternating halves `h₁,h₂` of the sorted concatenation `f || t`, then enforces in Fp²:

```
Z_L(ωx)/Z_L(x) =
  (1+β)(γ+f(x))(γ(1+β)+t(x)+βt(ωx)) /
  ((γ(1+β)+h₁(x)+βh₂(x))(γ(1+β)+h₂(x)+βh₁(ωx)))
```

`Z_L(1)=1`, and the cyclic product forces the sorted-concatenation relation. Range gates select their source into `f`; inactive rows use a fixed table dummy. For exact multisets (9×9 Sudoku), every query/table entry is paired with a fixed group tag and compressed as `value + β·tag`; one second grand product enforces `Z_L(ωx)(γ+t_β(x)) = Z_L(x)(γ+f_β(x))`. Thus 27 row/column/box claims share one bound argument without an uncommitted UI shortcut.

### 4.4 Constraint composition & quotient

With α ∈ Fp² from the transcript, `C` and `t` are Fp²-valued. Exact division is componentwise over the base-field vanishing polynomial:

```
C(x) = gate(x) + α·copy_transition(x) + α²·copy_boundary(x)
       + α³·lookup_transition(x) + α⁴·lookup_boundary(x)
t(x) = C(x) / Z_H(x)        — exact division iff all constraints hold on H
```

**The exact-division check is the pedagogical heart:** on an honest witness the remainder is the zero polynomial; on a tampered witness the prover UI shows the nonzero remainder and highlights exactly which rows of H have C(x_j) ≠ 0 — that's "the equation that catches you," stated in the trace table's own coordinates. The quotient is split into positional chunks of fewer than n coefficients. Non-blinded proofs need three chunks; blinding adds deterministic trailing chunks as required. At ζ the verifier recombines them as Σᵢ ζⁱⁿ·tᵢ(ζ).

### 4.5 Commitments

Polynomial → evaluations on D (coset LDE, blowup 8) → leaves hashed SHA-256 (leaf i = H(domainSep ‖ i ‖ eval bytes LE)) → binary Merkle tree → root is the commitment. Wire polys a, b, c share one tree with composite leaves (a_i‖b_i‖c_i) — one path per query instead of three. Z and t-chunks get their own trees (committed in different rounds — they must not share, the transcript orders them).

### 4.6 Prover pipeline (rounds)

```
0. absorb: protocol tag, params (n, blowup, queries), circuit digest, public inputs
1. interpolate a,b,c over H; ZK: add Z_H(x)·r_s(x), deg r = QUERIES+1; LDE; commit → absorb root
2. lookup membership only: commit sorted h₁,h₂ → absorb roots; squeeze β, γ ∈ Fp²; build copy Z and optional lookup Z_L (§4.3), blind, LDE, commit → absorb roots
3. squeeze α ∈ Fp²; build C, divide by Z_H (assert both-limb remainder 0), split Fp² t, commit chunks → absorb roots
4. squeeze ζ ∈ Fp² (resample the degenerate base-domain cases); open claimed Fp² evals: a(ζ), b(ζ), c(ζ), S_a(ζ), S_b(ζ), S_c(ζ), Z(ζ), Z(ωζ), t_*(ζ), plus lookup openings when present → absorb all
5. squeeze ρ ∈ Fp²; DEEP composition over D:
     Dp(x) = Σ_i ρ^i · (P_i(x) − P_i(ζ)) / (x − ζ)   [+ the Z-at-ωζ term with its own ρ power]
   run Fp² FRI on Dp (§4.7): fold/commit two-limb layers (absorb roots, squeeze Fp² fold challenges),
   final polynomial coefficients (deg < 8) in the clear,
   squeeze query indices; emit per-query openings: leaf+path from every committed tree
   at the queried D-positions plus FRI layer siblings.
```

The selector and σ polynomials are _preprocessed_: computed from the circuit by both sides, with the circuit digest absorbed in round 0. They are not supplied by the prover.

### 4.7 FRI

Standard halving fold over Fp². Layer L_j over base-field domain D_j (|D_0| = 8n); challenge β_j ∈ Fp²:

```
L_{j+1}(y) at y = x²:   (L_j(x) + L_j(−x))/2  +  β_j · (L_j(x) − L_j(−x))/(2x)
```

Commit each layer; stop when degree bound ≤ 8 and send coefficients. Queries: Q = 32 indices into D\_0 (squeezed post-commitment); each query walks the fold path checking (i) Merkle openings of L\_j at x and −x, (ii) the fold equation to L\_{j+1}, (iii) at layer 0, that L\_0's opened value equals the DEEP formula recomputed from the committed polys' opened leaves; final layer checked by direct evaluation of the sent coefficients.

### 4.8 Verifier (checklist-shaped)

`verify()` returns `{ ok, checks: CheckResult[] }` — never a bare boolean. The checklist _is_ the UI and _is_ the negative-test oracle:

| id  | check                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | transcript replay: every challenge re-derived from absorbed data matches                                                                                         |
| V2  | Fp² main identity at ζ: gate + public input + copy and optional lookup transition/boundary terms = t(ζ)·Z_H(ζ), with preprocessed polynomials recomputed locally |
| V3  | per query: all Merkle paths valid against absorbed roots                                                                                                         |
| V4  | per query: DEEP formula at x_q matches FRI layer-0 leaf                                                                                                          |
| V5  | per layer per query: fold equation holds                                                                                                                         |
| V6  | final FRI polynomial: claimed coefficients match final-layer leaves; degree < 8                                                                                  |
| V7  | parameter sanity: n, blowup, query count match the absorbed params                                                                                               |

### 4.9 Fiat–Shamir transcript

Hash-chain sponge over SHA-256: `state ← H(state ‖ label ‖ bytes)` on absorb; each Fp limb squeeze draws `H(state ‖ "squeeze" ‖ ctr)` blocks, takes 8 bytes LE, and **rejection-samples** ≥ p. An Fp² challenge samples two independently labeled limbs (`c0`,`c1`). Query indices use 4-byte draws mod |D| (bias 2⁻³², noted on screen). Labels are fixed strings ("wires-root", "beta-c0", "zeta-c1", …); the full absorb/squeeze log is part of `ProofTrace` and rendered with extension values in the transcript timeline. WebCrypto SHA-256 remains asynchronous in the worker.

### 4.10 Zero-knowledge mode & simulator

Blinding (§4.6 rounds 1–2) makes every opened evaluation — always off-H, by the coset choice — (Q+1)-wise independent of the witness. The **ZK tab** demonstrates rather than asserts:

- "What the verifier learned" ledger: literally every byte of the `Proof`, categorized (roots: hiding; evals: blinded; final poly: degree-8 junk).
- Real vs illustrated: a deterministic no-witness routine samples opening-shaped field values into a domain-separated transcript. It is deliberately not verifier-valid and is labeled honestly: "illustration of the ZK definition, not a formal proof."
- Histogram: an off-domain opening across 200 seeded runs is spread with blinding ON and concentrated with blinding OFF. Low-bit residue buckets make the contrast visible; the UI explicitly says this is a teaching visualization, not a statistical ZK proof.

### 4.11 Security readout (in-app, live)

Displayed with formulas, computed from actual parameters:

```
ε ≈ max( deg(C)/(p² − |D|)     [Schwartz–Zippel at ζ ∈ Fp²; deg(C) ≈ 4n, higher when blinded],
         (1/blowup)^Q ≈ 2⁻⁹⁶   [FRI queries, conjectured up to Johnson-bound caveats],
         2⁻³² per index         [query-index bias] )
→ at n=2⁹, blowup 8, Q=32: the identity term is about 2⁻¹¹⁷;
  the displayed maximum is 2⁻³² because the deliberately simple index sampler is the largest term
```

Copy beside it: "β, γ, α, ζ, ρ and every FRI fold challenge are sampled from Fp². Optional transcript-bound grinding is available. This remains a conjectured teaching-scale estimate, not a production-security claim." Claims of "conjectured" vs "proven" soundness use those words.

---

## 5. Circuit IR & compiler

```ts
type GateOp = 'pub' | 'priv' | 'const' | 'add' | 'mul' | 'assert0' | 'lookup';
interface Gate {
  id: number;
  op: GateOp;
  inputs: number[];
  value?: bigint; /* const value or lookup tag */
}
interface Circuit {
  gates: Gate[];
  publicOrder: number[];
  name: string;
  lookupTable?: bigint[];
  lookupMode?: 'membership' | 'multiset';
  lookupTableTags?: bigint[];
}
```

Wires are gate-output ids; fan-out creates the copy-constraint classes. Compiler: topological sort (cycle = validation error) → one row per arithmetic/lookup statement → public inputs pinned to the first ℓ rows → pad to a power of two large enough for both rows and the fixed lookup table → build σ from wire classes. Lookup statements are terminal and contribute `qLookup` plus an optional multiset tag; their input occupies the `a` slot. Witness gen: forward evaluation over the sort from the input assignment. **Tamper hook:** an `overrides: Map<wireId, bigint>` applied _after_ forward evaluation, no re-propagation — that's precisely what makes the constraint break locally and visibly downstream.

Canvas (React Flow): custom node per op (mono value chip, public = accent outline, private = dashed), including a terminal lookup node backed by the canvas table 0…15. Wires are the copy-constraint classes; the workbench copy states that connecting an output to an input _is_ the constraint. Structured input panels per preset overlay the canvas: both Sudoku grids, hash preimage field, and age slider.

---

## 6. UI spec

### 6.1 Layout

Shipped workshop is an IDE-style multi-pane chrome under the hero and claim toolbar: **Author** (Witness Script, course mode, structured inputs) · **Circuit** (React Flow workbench with copy-class edge colours) · **Bound** (live §4.11 security readout) spanning a three-column row, then full-width **Protocol** player and **ZK ledger** panes. On narrow viewports the panes stack vertically. Prove / cheat / grind / share live on the player; blinded teaching mode is a toolbar toggle. Course lessons deep-link via `#lesson=<id>` or `#stage=<n>` (share fragments `#p=` / `#pu=` still take precedence). The stage rail remains the protocol table of contents (§6.2). Workshop default FRI query count is **Q = 32**; the live readout recomputes from the selector immediately.

### 6.2 Player stages

0 circuit · 1 witness fill (trace table populates) · 2 interpolation (rows → polynomial, plotted) · 3 blind+commit wires (tree builds) · 4 Fp² β,γ · 5 copy and optional lookup grand products (telescoping columns — the §4.3 set-piece) · 6 commit Z roots · 7 Fp² α · 8 compose C, divide by Z_H (**remainder banner: green zero / red rows**) · 9 commit Fp² t · 10 Fp² ζ and its openings table · 11 identity at ζ · 12 Fp² DEEP composition · 13 Fp² FRI cascade · 14 queries · 15 verifier checklist (V1–V7 with live numbers).

Each stage: caption sentence, math line, payload. Prev/next/autoplay replays the current proof trace deterministically. Polynomial "plots" are honest field scatter (index vs value, mod-p wraparound); no pretend-continuity.

### 6.3 Cheat mode (the hero)

Entered from a completed valid proof. Three cards:

- **A1 Tamper the witness.** Trace table becomes editable (e.g., duplicate a Sudoku digit, set age 17). Pipeline re-runs; stage 8 shows the nonzero remainder rows; if the user forces the prover onward ("prove anyway"), V2 fails at stage 15 with the numbers side by side. Caption: "constraints don't vanish on H ⇒ t isn't a polynomial ⇒ the identity at ζ fails."
- **A2 Tamper a commitment.** Edit one committed leaf post-hoc. V3 fails at a specific query with the broken path highlighted node by node.
- **A3 Grind the challenge.** Interactive: drop to Q=1 query, let the malicious prover retry seeds until it slips a bad proof past the single check — live attempt counter converging to the predicted 2^bits; then restore Q=32 and show the projected count. Teaches "security bits = why the parameters."

Each attack is a real function in `attacks.ts`, exercised by the negative test suite (§9). The UI and the tests share the same malicious provers — the demo _is_ tested.

### 6.4 Verify-only mode

A share URL containing circuit + public inputs + proof opens straight into stage 15 with the checklist running locally and the player in "what the verifier sees" mode. The lean shared `Proof` never includes a witness or prover-only trace stages — inspectors that need those stay empty by design. "This page just verified a proof; it never saw a witness" — the product's thesis in one screen.

### 6.5 Visual language

Inter (UI) + JetBrains Mono (all field elements). Paper `#fbfaf7`, ink `#191a1c`, accent `#6d4ae0` (one violet — restrained), fail `#c0392b`, pass `#2e7d4f`. Field elements render as thin-space-grouped decimal strings in mono (inspectors and live payloads), with exact hex on hover. Canvas wires share a colour per copy-constraint class (source wire). The interface uses a light theme.

---

## 7. Presets

| #   | Claim                                    | Rows (est)                         | Teaches                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pythagorean: a²+b²=c²                    | 8 → n=2⁵                           | hello-world; **"fields are not integers"** callout: (3,4,5) works, but so do weird mod-p triples — arithmetization's first gotcha, taught deliberately                                                                                                                                                                                |
| 2   | Sudoku 4×4                               | generic arithmetic → n=2⁹          | the marquee. Cell domain: (v−1)(v−2)=d₁, (v−3)(v−4)=d₂, d₁·d₂=0 (3 mul rows/cell). All-different per row/col/box: sum=10 ∧ product=24 — **verified unique over domain-constrained cells** {1..4}⁴. Givens = public inputs. The generic gate baseline is intentionally retained (§12).                                                 |
| 3   | MiMC preimage: "I know x with MiMC(x)=y" | ~130 → n=2⁸                        | hashing in circuits. x\_{i+1} = (x\_i + c\_i)⁷, 32 rounds, feedforward output x₃₂ + x₀. Exponent 7 because x³ isn't a permutation here (§4.1). c₀=0, c\_i = first 8 bytes BE of SHA-256("witness/mimc/i") mod p. x⁷ = 4 mul rows. Honest note: preimages always exist (it's a permutation + feedforward); the proof shows _knowledge_ |
| 4   | Age ≥ 18 (without revealing age)         | 1 lookup → n=2⁷ (table-sized)      | Plookup membership in the fixed inclusive table 18…145; no auxiliary bit witnesses                                                                                                                                                                                                                                                    |
| 5   | Sudoku 9×9                               | 243 tagged lookups + givens → n=2⁹ | one Fp² grand product binds all 27 row/column/3×3-box multisets to tagged copies of {1,…,9}; givens are public inputs                                                                                                                                                                                                                 |

Golden vectors for preset 3 (from the independent Python reference, committed as fixtures and regenerated by `tools/reference.py`): MiMC(0) = 4624267046282251639 · MiMC(1) = 12880888997231784420 · MiMC(123456789) = 13938363197871553720.

---

## 8. Worker & serialization

`prover.worker.ts`: request `{ id, circuit, inputs, params, seed }` → progress events during orchestration → `ProofTrace` via structured clone across the worker boundary (BigInt-safe). Proof wire format: versioned JSON with bigints as decimal strings; share URL `#p=` + base64url(deflate-raw(JSON)) via CompressionStream, `#pu=` fallback. Circuit digest = SHA-256 of a canonical serialization of gates+selectors order — absorbed in round 0, so proof and circuit can't be mixed and matched.

---

## 9. Test plan (the honesty gates)

`src/zk/__tests__/`, Vitest node environment. fast-check for algebra laws. **The negative suite is the product promise in executable form.**

| Gate | Content                                                                                                                                                                                                                                                                | Expect                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Z1   | field laws (fast-check, 1000 cases): assoc/comm/distrib, inv·x=1, Fermat pow                                                                                                                                                                                           | pass                      |
| Z2   | fixed vectors §13: mul, add, inv(7), ω₈, ω₂¹⁶, 3^1000000007                                                                                                                                                                                                            | exact                     |
| Z3   | NTT: iNTT∘NTT = id for n = 2…2¹³; NTT = naive DFT for n ≤ 64                                                                                                                                                                                                           | exact                     |
| Z4   | poly: (f·g) div g exact; random-remainder division round-trips; barycentric L_i(ζ) vs direct                                                                                                                                                                           | exact                     |
| Z5   | permutation: hand-built 4-row copy case telescopes Z to 1; break one copy ⇒ Z(end) ≠ 1                                                                                                                                                                                 | exact                     |
| Z6   | quotient: honest witness ⇒ remainder 0; single tampered cell ⇒ remainder ≠ 0 exactly at affected rows                                                                                                                                                                  | exact                     |
| Z7   | FRI property: for random poly of deg < d, fold-of-evals = evals-of-folded (each layer); honest FRI verifies                                                                                                                                                            | exact                     |
| Z8   | E2E: four lightweight presets × 20 seeds plus 9×9 × 3 seeds prove → verify ok, every check V1–V7 green (dense 9×9 also under Z20)                                                                                                                                      | 100%                      |
| Z9   | **negative suite**: A1/A2 from `attacks.ts` × same preset/seed matrix ⇒ verify fails **at the expected check id** (A1→V2, A2→V3); A3 grinding statistics under Z12                                                                                                     | 100%                      |
| Z10  | golden transcript: fixed seed ⇒ byte-identical proof (fixture)                                                                                                                                                                                                         | frozen                    |
| Z11  | MiMC vectors match §7 fixtures; regenerable via tools/reference.py                                                                                                                                                                                                     | exact                     |
| Z12  | grinding statistics: Q=1 malicious prover succeeds in ~8 attempts median (rate 1/8); Q=2 in ~64                                                                                                                                                                        | within 3× over 200 trials |
| Z13  | ZK: blinding ON ⇒ opened values differ across seeds for same witness; OFF ⇒ they repeat                                                                                                                                                                                | exact                     |
| Z14  | share codec: decode(encode) round-trip for circuit+proof, both `#p` and `#pu` paths                                                                                                                                                                                    | exact                     |
| Z15  | Fp² kernel: irreducibility/non-residue, embedding, field laws, inversion, Fermat                                                                                                                                                                                       | exact                     |
| Z16  | workshop Poseidon vectors + optional Poseidon Merkle paths + transcript-bound grinding nonce                                                                                                                                                                           | exact                     |
| Z17  | Witness Script: pretty-print/parse property, frozen gallery lowerings, E2E prove/verify, shared A1/A2 attacks                                                                                                                                                          | exact                     |
| Z18  | canonical script provenance changes circuit digest, survives share round-trip, and leaves the frozen v1 wire fingerprint unchanged when absent                                                                                                                         | exact                     |
| Z19  | protocol-v2 propagation: β/γ/α/ζ/ρ and FRI folds are Fp² transcript squeezes; honest v2 proofs and v1 compatibility shares verify                                                                                                                                      | exact                     |
| Z20  | lookup bundle: Plookup range membership, lookup share round-trip, out-of-table A1→V2, tagged 9×9 multiset honest proof, duplicate cell→V2, shared leaf attack→V3                                                                                                       | exact                     |
| Z21  | honesty copy: source scan keeps "conjectured"/"teaching-scale", the live §4.11 formula shape, the identity-only lesson's **unsound alone** label, and the ZK "illustration … not a formal proof" wording on every load-bearing surface; `src/zk/` stays React/DOM-free | exact                     |

All Z1–Z21 gates are executable. Z8/Z9 cover all five presets (20 seeds for the four lightweight circuits; 3 seeds for 9×9, with denser 9×9 coverage under Z20). Z12 pairs a protocol-v1 compatibility forged-proof smoke run with a bounded 200-trial selected-coset distribution check; A1 and A2 exercise the protocol-v2 prover and verifier directly. The UI and tests import the same attack functions. Z18 freezes provenance-free v1 share fingerprints; Z19 covers Fp² challenge propagation and v1 compatibility share verification. Z21 fails CI if honesty wording regresses.

---

## 12. Decision log

| Decision                                                                                  | Alternatives                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLONK arithmetization + FRI commitment (transparent)                                      | Groth16/KZG-PLONK (pairings)                                      | pairings mean months of tower-field/Miller-loop work that visualizes as "then magic happens" — the opposite of the product. FRI is hash-based: every step (fold, commit, query) is drawable and from-scratch implementable. Also no trusted setup — a whole class of hand-waving deleted                                                                                                |
| PLONK gates, not AIR/STARK traces                                                         | STARK-style AIR                                                   | the canvas metaphor is a circuit; PLONK rows map 1:1 to drawn gates, and copy constraints (the permutation argument) are the most visual algebra in ZK — the telescoping product is a set-piece, not overhead                                                                                                                                                                           |
| Goldilocks base field with quadratic challenge extension                                  | BN254 scalar field / BabyBear                                     | 64-bit limbs stay BigInt-native and readable, 2-adicity 32 supports the domains, while Fp² moves the ζ identity term well beyond the old base-field limit. The combined estimate is still conjectured and exposes its 32-bit index-bias term.                                                                                                                                           |
| Protocol wire v2 propagates Fp² atomically; retain v1 decode/verify compatibility         | silently claim extension-field soundness from a standalone kernel | β/γ/α/ζ/ρ, PLONK identities, DEEP, FRI folds, two-limb Merkle leaves, share encoding, inspector rendering, and the live bound moved together. Frozen v1 links still decode and verify for the lookup-free circuits they were produced for, and the identity-only lesson remains a separately labeled unsound-alone v1 surface.                                                          |
| SHA-256 commitments plus workshop Poseidon                                                | replace the proof commitment hash                                 | WebCrypto SHA-256 remains the audited asynchronous commitment path. A separate reproducible width-3/x⁷ Poseidon parameterization powers the in-circuit gallery, and an optional Poseidon Merkle tree is kept beside it as a gate-tested kernel component rather than a proof-path commitment; both are explicitly teaching-scale and not presented as Plonky2 or production parameters. |
| Keep 4×4 arithmetic Sudoku and add a tagged-multiset 9×9 preset                           | replace the readable 4×4 lesson                                   | 4×4 remains the compact arithmetic teaching case; 9×9 uses β-compressed `(digit, group)` pairs and one exact multiset grand product for all 27 groups.                                                                                                                                                                                                                                  |
| Attack lab shares code with the negative test suite                                       | cheating as an untested easter egg                                | The demo attacks are the tested attacks, so the product claim fails with the same gate as the protocol.                                                                                                                                                                                                                                                                                 |
| ZK illustration + learned-bytes ledger                                                    | assert "it's ZK, trust us"                                        | The workshop shows what testimony (the private input) reveals and what it does not. The no-witness transcript remains explicitly illustrative rather than a formal simulator proof.                                                                                                                                                                                                     |
| Verify-only share links                                                                   | share screenshots                                                 | A recipient's browser re-runs V1–V7 locally, end to end, with no backend.                                                                                                                                                                                                                                                                                                               |
| Security readout with a live formula                                                      | static disclaimer                                                 | Parameter modesty is part of the lesson instead of a footnote.                                                                                                                                                                                                                                                                                                                          |
| Plookup ranges + 9×9 Sudoku as one protocol bundle                                        | unbound lookup UI or ad-hoc range gate                            | Membership commits sorted h₁/h₂ and Z_L; tagged multiset mode commits its own Z_L. Both flow through the quotient, DEEP composition, Merkle queries, transcript, share codec, player, and shared negative attacks. One fixed membership table per circuit keeps the teaching IR inspectable; Witness Script diagnoses mixed range bounds instead of silently weakening them.            |
| Exclude recursion, custom gates, and a published package API                              | broaden the project into a library                                | This repository is a workshop rather than a general-purpose proof library.                                                                                                                                                                                                                                                                                                              |
| Keep generic preset arithmetic                                                            | add another custom range/domain gate                              | The presets remain inspectable in the seven-op IR (six original operations plus terminal lookup), the documented baselines fit the workshop domain cap, and the NTT performance budget passes. Revisit selector fusion only if a measured regression justifies the added complexity.                                                                                                    |
| Next.js static export                                                                     | Vite                                                              | Static export preserves the everything-in-the-browser contract. Accepted costs are a per-host `BASE_PATH` and framework weight for a client-only app. The kernel and tests remain bundler-agnostic.                                                                                                                                                                                     |
| Dual CI (GitHub + GitLab)                                                                 | pick one                                                          | Both pipelines are thin mirrors of the same commands and support project-site deployment without changing the release checks.                                                                                                                                                                                                                                                           |
| CodeMirror 6 for Witness Script                                                           | hand-rolled text editor                                           | Parsing, selections, input handling, and accessibility are not workshop material; the editor is a focused authoring surface while the language compiler remains dependency-free and node-testable.                                                                                                                                                                                      |
| Fixed collections in Witness Script are scalarized                                        | add runtime array values and dynamic indexing                     | The language stays total and field-only: gallery collections use named scalar inputs and bounded loops unroll at compile time. It has no array runtime, heap, or dynamic indexing protocol.                                                                                                                                                                                             |
| Widen Next's exact PostCSS pin within the patched 8.5 line                                | retain two incompatible top-level requirements                    | Next pins 8.5.23 while Vite requires ^8.5.25. The targeted override lets npm resolve one compatible patched release without changing either application API.                                                                                                                                                                                                                            |
| Thin-space/hex fields, copy-class colours, multi-pane chrome, course deep links, and Q=32 | omit optional visual polish                                       | These surfaces keep the interface and live §4.11 readout aligned with the workshop defaults while preserving the conjectured, teaching-scale qualification.                                                                                                                                                                                                                             |
| Honesty spot-checks as Z21 source scans                                                   | rely on human wording review alone                                | CI fails if "conjectured"/"teaching-scale", the live formula, the identity-only unsound-alone label, or the ZK illustration wording disappears from a load-bearing surface.                                                                                                                                                                                                             |
| Production dependency audit in CI                                                         | accept known advisories                                           | Re-run the live advisory check before each public publish and update the lockfile when a compatible patched dependency is available.                                                                                                                                                                                                                                                    |

---

## 13. Appendix — verified constants & fixtures

All independently computed in Python (regenerate with `tools/reference.py`):

```
p                    = 18446744069414584321 = 2^64 − 2^32 + 1
p − 1                = 2^32 · 3 · 5 · 17 · 257 · 65537        (verified)
7 primitive          (7^((p−1)/q) ≠ 1 for all prime q | p−1)  (verified)
7 QNR                (7^((p−1)/2) = p − 1)                     (verified)
inv(7)               = 2635249152773512046
ω₈  = 7^((p−1)/8)    = 18446744069397807105
ω₂¹⁶                 = 6115771955107415310
mul: 16045690981402826360 · 14627333967224062753 = 11964319653047658634
add: 16045690981402826360 + 14627333967224062753 = 12226280879212304792
pow: 3^1000000007    = 16525317176295360948
MiMC c₁..c₄          = 8168653483647768157, 13085671528423842430,
                       4475564587774687424, 15672704788461018095
MiMC(0)              = 4624267046282251639
MiMC(1)              = 12880888997231784420
MiMC(123456789)      = 13938363197871553720
Poseidon(0, 0)        = 13593260552114296815
Poseidon(1, 2)        = 18371212222320491351
```

**References for the curious** (not required to build): Gabizon–Williamson–Ciobotaru, _PLONK_; Ben-Sasson et al., _FRI_; StarkWare's STARK 101 (the nearest pedagogical ancestor — trace-based where this is circuit-based, and without the cheat); Plonky2 writeups (a production system whose architecture this teaching design echoes).

**Repo conventions:** strict TS (`strict`, `noUncheckedIndexedAccess`); `src/zk/` imports nothing from DOM or React (enforced by oxlint path restrictions and gate tests); all bigint literals suffixed `n`; no new runtime deps without a decision-log row; every function implementing a §4 formula cites its section.

---
