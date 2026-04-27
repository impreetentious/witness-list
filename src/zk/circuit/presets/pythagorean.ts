/**
 * Preset 1: "I know (a,b) with a² + b² = c²" for public c. docs/PROTOCOL-SPEC.md §7.
 * IMPLEMENTED as the preset-format anchor: hand-authored layout, structured
 * input mapping, and the "fields are not integers" teaching callout.
 */
import type { Circuit } from '../ir';

// Gate ids are wire ids. publicOrder pins c to row 0.
export const pythagorean: Circuit = {
  name: 'Pythagorean triple',
  gates: [
    { id: 1, op: 'pub', inputs: [], pos: { x: 380, y: 40 } }, // c (public)
    { id: 2, op: 'priv', inputs: [], pos: { x: 40, y: 40 } }, // a (witness)
    { id: 3, op: 'priv', inputs: [], pos: { x: 40, y: 160 } }, // b (witness)
    { id: 4, op: 'mul', inputs: [2, 2], pos: { x: 180, y: 40 } }, // a²
    { id: 5, op: 'mul', inputs: [3, 3], pos: { x: 180, y: 160 } }, // b²
    { id: 6, op: 'mul', inputs: [1, 1], pos: { x: 380, y: 160 } }, // c²
    { id: 7, op: 'add', inputs: [4, 5], pos: { x: 300, y: 100 } }, // a²+b²
    // a²+b² − c² = 0, expressed as add with negated input handled by compiler
    // Sugar: assert0(sub(7,6)). The IR keeps only add/mul, so:
    { id: 8, op: 'mul', inputs: [6, 9], pos: { x: 460, y: 100 } }, // c²·(−1)
    { id: 9, op: 'const', inputs: [], value: -1n, pos: { x: 460, y: 180 } }, // −1 (reduced mod p at compile)
    { id: 10, op: 'add', inputs: [7, 8], pos: { x: 560, y: 100 } }, // a²+b²−c²
    { id: 11, op: 'assert0', inputs: [10], pos: { x: 660, y: 100 } },
  ],
  publicOrder: [1],
};

/** Structured input panel spec (docs/PROTOCOL-SPEC.md §5): three integer fields, default 3,4,5. */
export const pythagoreanInputs = {
  fields: [
    { wire: 2, label: 'a (private)', default: 3n },
    { wire: 3, label: 'b (private)', default: 4n },
    { wire: 1, label: 'c (public)', default: 5n },
  ],
  callout:
    'Fields are not integers: (3,4,5) works, but so do strange mod-p triples. ' +
    'Arithmetization proves the equation over F_p — bounding values is extra work (see preset 4).',
};
