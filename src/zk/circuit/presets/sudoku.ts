/** Preset 2: 4×4 Sudoku. Uses only generic v1 arithmetic gates. */
import type { Fp } from '../../field';
import type { Circuit } from '../ir';
import { PresetBuilder } from './builder';

export const sudokuSolution = [
  [1n, 2n, 3n, 4n],
  [3n, 4n, 1n, 2n],
  [2n, 1n, 4n, 3n],
  [4n, 3n, 2n, 1n],
] as const;

export interface SudokuGiven {
  row: number;
  column: number;
  value: Fp;
  publicWire: number;
}

export const sudokuCellWires: number[][] = [];
export const sudokuGivens: SudokuGiven[] = [];

function buildSudoku(): Circuit {
  const builder = new PresetBuilder();
  const givenCoordinates = [
    { row: 0, column: 0 },
    { row: 0, column: 3 },
    { row: 1, column: 1 },
    { row: 3, column: 2 },
  ];
  const publicOrder = givenCoordinates.map(() => builder.pub());
  sudokuGivens.push(
    ...givenCoordinates.map(({ row, column }, index) => ({
      row,
      column,
      value: sudokuSolution[row]![column]!,
      publicWire: publicOrder[index]!,
    })),
  );

  for (let row = 0; row < 4; row++) {
    const wires: number[] = [];
    for (let column = 0; column < 4; column++) wires.push(builder.priv());
    sudokuCellWires.push(wires);
  }

  const minusOne = builder.constant(-1n);
  const minusTwo = builder.constant(-2n);
  const minusThree = builder.constant(-3n);
  const minusFour = builder.constant(-4n);
  const minusTen = builder.constant(-10n);
  const minusTwentyFour = builder.constant(-24n);

  for (const row of sudokuCellWires) {
    for (const cell of row) {
      const d1 = builder.mul(builder.add(cell, minusOne), builder.add(cell, minusTwo));
      const d2 = builder.mul(builder.add(cell, minusThree), builder.add(cell, minusFour));
      builder.assertZero(builder.mul(d1, d2));
    }
  }

  const groups = [
    ...sudokuCellWires,
    ...Array.from({ length: 4 }, (_, column) => sudokuCellWires.map((row) => row[column]!)),
    ...[0, 2].flatMap((rowStart) => [0, 2].map((columnStart) => [
      sudokuCellWires[rowStart]![columnStart]!,
      sudokuCellWires[rowStart]![columnStart + 1]!,
      sudokuCellWires[rowStart + 1]![columnStart]!,
      sudokuCellWires[rowStart + 1]![columnStart + 1]!,
    ])),
  ];

  for (const group of groups) {
    const sum = builder.add(builder.add(group[0]!, group[1]!), builder.add(group[2]!, group[3]!));
    builder.assertZero(builder.add(sum, minusTen));
    const product = builder.mul(builder.mul(group[0]!, group[1]!), builder.mul(group[2]!, group[3]!));
    builder.assertZero(builder.add(product, minusTwentyFour));
  }

  for (const given of sudokuGivens) {
    const negatedPublic = builder.mul(given.publicWire, minusOne);
    builder.assertZero(builder.add(sudokuCellWires[given.row]![given.column]!, negatedPublic));
  }

  return builder.build('Sudoku 4×4', publicOrder);
}

export const sudoku: Circuit = buildSudoku();

/** Structured input panel mapping: private solution cells plus public givens. */
export function sudokuInputs(solution: readonly (readonly Fp[])[] = sudokuSolution): Map<number, Fp> {
  if (solution.length !== 4 || solution.some((row) => row.length !== 4)) {
    throw new Error('Sudoku input must be a 4×4 grid');
  }
  const inputs = new Map<number, Fp>();
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      inputs.set(sudokuCellWires[row]![column]!, solution[row]![column]!);
    }
  }
  for (const given of sudokuGivens) inputs.set(given.publicWire, solution[given.row]![given.column]!);
  return inputs;
}
