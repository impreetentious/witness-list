/** 9×9 Sudoku: lookup membership plus exact row/column/box multiset identities. */
import type { Fp } from '../../field';
import type { Circuit } from '../ir';
import { PresetBuilder } from './builder';

export const sudoku9Solution = [
  [5n, 3n, 4n, 6n, 7n, 8n, 9n, 1n, 2n],
  [6n, 7n, 2n, 1n, 9n, 5n, 3n, 4n, 8n],
  [1n, 9n, 8n, 3n, 4n, 2n, 5n, 6n, 7n],
  [8n, 5n, 9n, 7n, 6n, 1n, 4n, 2n, 3n],
  [4n, 2n, 6n, 8n, 5n, 3n, 7n, 9n, 1n],
  [7n, 1n, 3n, 9n, 2n, 4n, 8n, 5n, 6n],
  [9n, 6n, 1n, 5n, 3n, 7n, 2n, 8n, 4n],
  [2n, 8n, 7n, 4n, 1n, 9n, 6n, 3n, 5n],
  [3n, 4n, 5n, 2n, 8n, 6n, 1n, 7n, 9n],
] as const;

export interface Sudoku9Given {
  row: number;
  column: number;
  value: Fp;
  publicWire: number;
}
export const sudoku9CellWires: number[][] = [];
export const sudoku9Givens: Sudoku9Given[] = [];

function buildSudoku9(): Circuit {
  const builder = new PresetBuilder();
  const givenCoordinates = [
    [0, 0],
    [0, 1],
    [0, 4],
    [1, 0],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 1],
    [2, 2],
    [2, 7],
    [3, 0],
    [3, 4],
    [3, 8],
    [4, 0],
    [4, 3],
    [4, 5],
    [4, 8],
    [5, 0],
    [5, 4],
    [5, 8],
    [6, 1],
    [6, 6],
    [6, 7],
    [7, 3],
    [7, 4],
    [7, 5],
    [7, 8],
    [8, 4],
    [8, 7],
    [8, 8],
  ] as const;
  const publicOrder = givenCoordinates.map(() => builder.pub());
  sudoku9Givens.push(
    ...givenCoordinates.map(([row, column], index) => ({
      row,
      column,
      value: sudoku9Solution[row]![column]!,
      publicWire: publicOrder[index]!,
    })),
  );
  for (let row = 0; row < 9; row++) {
    const wires = Array.from({ length: 9 }, () => builder.priv());
    sudoku9CellWires.push(wires);
  }

  const groups = [
    ...Array.from({ length: 9 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) => [row, column] as const),
    ),
    ...Array.from({ length: 9 }, (_, column) =>
      Array.from({ length: 9 }, (_, row) => [row, column] as const),
    ),
    ...[0, 3, 6].flatMap((rowStart) =>
      [0, 3, 6].map((columnStart) =>
        Array.from(
          { length: 9 },
          (_, offset) => [rowStart + Math.floor(offset / 3), columnStart + (offset % 3)] as const,
        ),
      ),
    ),
  ];
  const lookupTable: bigint[] = [];
  const lookupTags: bigint[] = [];
  // β compresses (digit, group-id). One grand product binds all 27 private
  // group multisets to 27 fixed copies of {1,…,9}.
  groups.forEach((group, tag) => {
    for (const [row, column] of group) builder.lookup(sudoku9CellWires[row]![column]!, BigInt(tag));
    for (let digit = 1; digit <= 9; digit++) {
      lookupTable.push(BigInt(digit));
      lookupTags.push(BigInt(tag));
    }
  });
  const minusOne = builder.constant(-1n);
  for (const given of sudoku9Givens) {
    builder.assertZero(
      builder.add(
        sudoku9CellWires[given.row]![given.column]!,
        builder.mul(given.publicWire, minusOne),
      ),
    );
  }
  return builder.buildMultiset(
    'Sudoku 9×9 · Lookup Multisets',
    publicOrder,
    lookupTable,
    lookupTags,
  );
}

export const sudoku9: Circuit = buildSudoku9();

export function sudoku9Inputs(
  solution: readonly (readonly Fp[])[] = sudoku9Solution,
): Map<number, Fp> {
  if (solution.length !== 9 || solution.some((row) => row.length !== 9))
    throw new Error('Sudoku input must be a 9×9 grid');
  const inputs = new Map<number, Fp>();
  for (let row = 0; row < 9; row++)
    for (let column = 0; column < 9; column++)
      inputs.set(sudoku9CellWires[row]![column]!, solution[row]![column]!);
  for (const given of sudoku9Givens)
    inputs.set(given.publicWire, solution[given.row]![given.column]!);
  return inputs;
}
