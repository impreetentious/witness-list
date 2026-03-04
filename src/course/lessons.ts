/** Phase 2 course-mode lessons. The player remains the source of live data. */
export interface Lesson {
  id: string;
  title: string;
  stage: number;
  prompt: string;
  task: string;
}

export const lessons: readonly Lesson[] = [
  { id: 'statement', title: '1 · Fix the statement', stage: 0, prompt: 'A proof starts with a circuit and its public inputs, not with an algebraic trick.', task: 'Open stage 0 and identify the circuit digest that binds the claim.' },
  { id: 'witness', title: '2 · Fill the witness', stage: 1, prompt: 'The wire table is private; only commitments and selected openings leave the prover.', task: 'Toggle “what the verifier sees” and compare it with the trace table.' },
  { id: 'permutation', title: '3 · Follow Z', stage: 5, prompt: 'Copy constraints become one telescoping grand product.', task: 'Inspect the partial products and find the final value.' },
  { id: 'quotient', title: '4 · Catch a lie', stage: 8, prompt: 'A valid constraint polynomial divides by the trace vanishing polynomial exactly.', task: 'Run the witness-tamper attack and name the first nonzero remainder row.' },
  { id: 'fri', title: '5 · Test degree', stage: 13, prompt: 'FRI repeatedly folds a committed evaluation table until a small polynomial remains.', task: 'Compare two neighboring FRI roots in the cascade.' },
  { id: 'verify', title: '6 · Verify without witness', stage: 15, prompt: 'The verifier sees a small proof, replayed challenges, and authenticated openings—not the witness.', task: 'Share a proof URL and load it in a fresh browser context.' },
  { id: 'zk', title: '7 · Read the ledger', stage: 10, prompt: 'Blinding changes off-trace openings; the transcript panel is an illustration, not a formal simulator proof.', task: 'Run blinded teaching mode twice with different seeds and compare an opening.' },
  { id: 'grinding', title: '8 · Price a retry', stage: 14, prompt: 'A post-commitment work nonce makes repeated query fishing more expensive.', task: 'Set a small anti-grinding factor and locate its nonce before the queries.' },
  { id: 'script', title: '9 · Write the claim', stage: 0, prompt: 'Witness Script lowers a small, total claim into the same inspectable circuit IR as the canvas.', task: 'Load the five-line Pythagorean claim, change one input, and compile it into the canvas.' },
  { id: 'provenance', title: '10 · Bind the source', stage: 0, prompt: 'Canonical script provenance is included in the circuit digest and travels with a proof share.', task: 'Format a script, prove it, and confirm its source reappears after loading the shared fragment.' },
];
