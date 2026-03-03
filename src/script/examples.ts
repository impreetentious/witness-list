/** Built-in Witness Script examples. Each one compiles to the same Circuit IR as the canvas. */

export interface WitnessScriptExample {
  id: string;
  title: string;
  source: string;
  inputs: Record<string, bigint>;
}

const sudoku4Solution = [
  [1n, 2n, 3n, 4n],
  [3n, 4n, 1n, 2n],
  [2n, 1n, 4n, 3n],
  [4n, 3n, 2n, 1n],
] as const;

const sudoku4Cell = (row: number, column: number): string => `c${row}${column}`;
const sudoku4Groups = [
  ...Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => sudoku4Cell(row, column))),
  ...Array.from({ length: 4 }, (_, column) => Array.from({ length: 4 }, (_, row) => sudoku4Cell(row, column))),
  ...[0, 2].flatMap((rowStart) => [0, 2].map((columnStart) => [
    sudoku4Cell(rowStart, columnStart),
    sudoku4Cell(rowStart, columnStart + 1),
    sudoku4Cell(rowStart + 1, columnStart),
    sudoku4Cell(rowStart + 1, columnStart + 1),
  ])),
];
const sudoku4Givens = [
  { name: 'given00', row: 0, column: 0 },
  { name: 'given03', row: 0, column: 3 },
  { name: 'given11', row: 1, column: 1 },
  { name: 'given32', row: 3, column: 2 },
] as const;
const sudoku4Source = [
  'claim Sudoku4Script {',
  ...sudoku4Givens.map(({ name }) => `  public ${name}: field;`),
  ...sudoku4Solution.flatMap((row, rowIndex) => row.map((_, columnIndex) => `  private ${sudoku4Cell(rowIndex, columnIndex)}: field;`)),
  ...sudoku4Solution.flatMap((row, rowIndex) => row.map((_, columnIndex) => `  range ${sudoku4Cell(rowIndex, columnIndex)} in 1..4;`)),
  ...sudoku4Groups.flatMap((group) => [
    `  assert ${group.join(' + ')} == 10;`,
    `  assert ${group.join(' * ')} == 24;`,
  ]),
  ...sudoku4Givens.map(({ name, row, column }) => `  assert ${sudoku4Cell(row, column)} == ${name};`),
  '}',
].join('\n');
const sudoku4Inputs: Record<string, bigint> = Object.fromEntries([
  ...sudoku4Solution.flatMap((row, rowIndex) => row.map((value, columnIndex) => [sudoku4Cell(rowIndex, columnIndex), value] as const)),
  ...sudoku4Givens.map(({ name, row, column }) => [name, sudoku4Solution[row][column]] as const),
]);

export const witnessScriptExamples: readonly WitnessScriptExample[] = [
  {
    id: 'pythagorean',
    title: 'Pythagorean Triple',
    source: `claim PythagoreanScript {
  public c: field;
  private a: field;
  private b: field;
  let left = a * a + b * b;
  let right = c * c;
  assert left == right;
}`,
    inputs: { a: 3n, b: 4n, c: 5n },
  },
  {
    id: 'sudoku4',
    title: 'Sudoku 4×4',
    source: sudoku4Source,
    inputs: sudoku4Inputs,
  },
  {
    id: 'age',
    title: 'Age ≥ 18',
    source: `claim AdultScript {
  private age: field;
  range age in 18..145;
}`,
    inputs: { age: 21n },
  },
  {
    id: 'mimc',
    title: 'MiMC Preimage',
    source: `claim MimcPreimageScript {
  public digest: field;
  private preimage: field;
  assert mimc(preimage) == digest;
}`,
    inputs: { preimage: 123456789n, digest: 13938363197871553720n },
  },
  {
    id: 'poseidon',
    title: 'Poseidon Compression',
    source: `claim PoseidonCompressionScript {
  public digest: field;
  private left: field;
  private right: field;
  assert poseidon(left, right) == digest;
}`,
    inputs: { left: 1n, right: 2n, digest: 18371212222320491351n },
  },
  {
    id: 'merkle',
    title: 'Poseidon Merkle Membership',
    source: `claim MerkleMembershipScript {
  public root: field;
  private leaf: field;
  private sibling0: field;
  private direction0: field;
  private sibling1: field;
  private direction1: field;
  let parent0 = merkle_path(leaf, sibling0, direction0);
  let parent1 = merkle_path(parent0, sibling1, direction1);
  assert parent1 == root;
}`,
    inputs: {
      leaf: 3n,
      sibling0: 5n,
      direction0: 0n,
      sibling1: 3566829164420980907n,
      direction1: 0n,
      root: 10598859654394985856n,
    },
  },
];
