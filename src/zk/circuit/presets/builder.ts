/**
 * Small authoring helper for preset circuits. It emits only the seven public
 * IR operations — presets do not introduce custom gates. docs/PROTOCOL-SPEC.md §§5, 7.
 */
import type { Circuit, Gate, GateOp } from '../ir';

export class PresetBuilder {
  private nextId = 1;
  private readonly gates: Gate[] = [];

  public gate(op: GateOp, inputs: number[] = [], value?: bigint): number {
    const id = this.nextId++;
    const pos = { x: 40 + ((id - 1) % 8) * 140, y: 40 + Math.floor((id - 1) / 8) * 100 };
    this.gates.push({ id, op, inputs, ...(value === undefined ? {} : { value }), pos });
    return id;
  }

  public pub(): number {
    return this.gate('pub');
  }

  public priv(): number {
    return this.gate('priv');
  }

  public constant(value: bigint): number {
    return this.gate('const', [], value);
  }

  public add(left: number, right: number): number {
    return this.gate('add', [left, right]);
  }

  public mul(left: number, right: number): number {
    return this.gate('mul', [left, right]);
  }

  public assertZero(value: number): number {
    return this.gate('assert0', [value]);
  }

  public lookup(value: number, tag = 0n): number {
    return this.gate('lookup', [value], tag);
  }

  public build(name: string, publicOrder: number[], lookupTable?: bigint[]): Circuit {
    return {
      name,
      gates: this.gates,
      publicOrder,
      ...(lookupTable === undefined ? {} : { lookupTable }),
    };
  }

  public buildMultiset(
    name: string,
    publicOrder: number[],
    lookupTable: bigint[],
    lookupTableTags: bigint[],
  ): Circuit {
    return {
      name,
      gates: this.gates,
      publicOrder,
      lookupTable,
      lookupMode: 'multiset',
      lookupTableTags,
    };
  }
}
