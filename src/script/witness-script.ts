/**
 * Witness Script — a deliberately small claim language compiled to the
 * repository's seven-operation circuit IR. Parsing and lowering stay pure and
 * DOM-free; the CodeMirror component is only an authoring view.
 *
 * Supported surface: claim blocks, public/private field inputs, let bindings,
 * arithmetic expressions, equality assertions, inclusive bounded ranges, and
 * statically bounded for loops. The standard library exposes MiMC and the
 * workshop Poseidon permutation; no recursion or unbounded loop exists.
 */
import type { Circuit } from '../zk/circuit/ir';
import { mimcConstant } from '../zk/circuit/presets/mimc';
import { PresetBuilder } from '../zk/circuit/presets/builder';
import { POSEIDON_FULL_ROUNDS, POSEIDON_MDS, POSEIDON_PARTIAL_ROUNDS, poseidonRoundConstants } from '../zk/poseidon';

type TokenKind = 'identifier' | 'number' | 'symbol' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

export interface ScriptDiagnostic {
  message: string;
  start: number;
  end: number;
}

export class WitnessScriptError extends Error {
  readonly diagnostic: ScriptDiagnostic;

  constructor(message: string, start: number, end: number = start + 1) {
    super(message);
    this.name = 'WitnessScriptError';
    this.diagnostic = { message, start, end };
  }
}

type Expression =
  | { kind: 'number'; value: bigint; token: Token }
  | { kind: 'name'; name: string; token: Token }
  | { kind: 'binary'; operator: '+' | '-' | '*'; left: Expression; right: Expression; token: Token }
  | { kind: 'call'; name: string; args: Expression[]; token: Token };

type Statement =
  | { kind: 'input'; visibility: 'public' | 'private'; name: string; token: Token }
  | { kind: 'let'; name: string; expression: Expression; token: Token }
  | { kind: 'assert'; left: Expression; right: Expression; token: Token }
  | { kind: 'range'; name: string; lower: number; upper: number; token: Token }
  | { kind: 'for'; name: string; lower: number; upper: number; body: Statement[]; token: Token };

export interface WitnessScriptProgram {
  name: string;
  statements: Statement[];
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    if (/\s/.test(current)) {
      index++;
      continue;
    }
    if (current === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index++;
      tokens.push({ kind: 'identifier', text: source.slice(start, index), start, end: index });
      continue;
    }
    if (/\d/.test(current)) {
      const start = index++;
      while (index < source.length && /\d/.test(source[index]!)) index++;
      tokens.push({ kind: 'number', text: source.slice(start, index), start, end: index });
      continue;
    }
    const two = source.slice(index, index + 2);
    if (two === '==' || two === '..') {
      tokens.push({ kind: 'symbol', text: two, start: index, end: index + 2 });
      index += 2;
      continue;
    }
    if ('{}():;,=+-*'.includes(current)) {
      tokens.push({ kind: 'symbol', text: current, start: index, end: index + 1 });
      index++;
      continue;
    }
    throw new WitnessScriptError(`Unexpected character ${JSON.stringify(current)}.`, index, index + 1);
  }
  tokens.push({ kind: 'eof', text: '', start: source.length, end: source.length });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private current(): Token {
    return this.tokens[this.index]!;
  }

  private advance(): Token {
    const token = this.current();
    if (token.kind !== 'eof') this.index++;
    return token;
  }

  private expect(text: string): Token {
    const token = this.current();
    if (token.text !== text) throw new WitnessScriptError(`Expected ${JSON.stringify(text)}, found ${token.kind === 'eof' ? 'end of file' : JSON.stringify(token.text)}.`, token.start, token.end);
    return this.advance();
  }

  private identifier(): Token {
    const token = this.current();
    if (token.kind !== 'identifier') throw new WitnessScriptError('Expected an identifier.', token.start, token.end);
    return this.advance();
  }

  private integer(): { value: number; token: Token } {
    const token = this.current();
    if (token.kind !== 'number') throw new WitnessScriptError('Expected a non-negative integer.', token.start, token.end);
    const value = Number(token.text);
    if (!Number.isSafeInteger(value)) throw new WitnessScriptError('Integer is too large for a loop or range bound.', token.start, token.end);
    this.advance();
    return { value, token };
  }

  parse(): WitnessScriptProgram {
    this.expect('claim');
    const name = this.identifier();
    this.expect('{');
    const statements = this.statements('}');
    this.expect('}');
    if (this.current().kind !== 'eof') throw new WitnessScriptError('Only one claim block is allowed.', this.current().start, this.current().end);
    return { name: name.text, statements };
  }

  private statements(end: string): Statement[] {
    const statements: Statement[] = [];
    while (this.current().text !== end) {
      if (this.current().kind === 'eof') throw new WitnessScriptError(`Expected ${JSON.stringify(end)} before end of file.`, this.current().start);
      statements.push(this.statement());
    }
    return statements;
  }

  private statement(): Statement {
    const token = this.current();
    if (token.text === 'public' || token.text === 'private') {
      this.advance();
      const name = this.identifier();
      this.expect(':');
      this.expect('field');
      this.expect(';');
      return { kind: 'input', visibility: token.text, name: name.text, token };
    }
    if (token.text === 'let') {
      this.advance();
      const name = this.identifier();
      this.expect('=');
      const expression = this.expression();
      this.expect(';');
      return { kind: 'let', name: name.text, expression, token };
    }
    if (token.text === 'assert') {
      this.advance();
      const left = this.expression();
      this.expect('==');
      const right = this.expression();
      this.expect(';');
      return { kind: 'assert', left, right, token };
    }
    if (token.text === 'range') {
      this.advance();
      const name = this.identifier();
      this.expect('in');
      const lower = this.integer();
      this.expect('..');
      const upper = this.integer();
      this.expect(';');
      if (upper.value < lower.value) throw new WitnessScriptError('A range upper bound must not be smaller than its lower bound.', lower.token.start, upper.token.end);
      return { kind: 'range', name: name.text, lower: lower.value, upper: upper.value, token };
    }
    if (token.text === 'for') {
      this.advance();
      const name = this.identifier();
      this.expect('in');
      const lower = this.integer();
      this.expect('..');
      const upper = this.integer();
      if (upper.value < lower.value) throw new WitnessScriptError('A loop upper bound must not be smaller than its lower bound.', lower.token.start, upper.token.end);
      this.expect('{');
      const body = this.statements('}');
      this.expect('}');
      return { kind: 'for', name: name.text, lower: lower.value, upper: upper.value, body, token };
    }
    throw new WitnessScriptError(`Expected a statement, found ${JSON.stringify(token.text)}.`, token.start, token.end);
  }

  private expression(minimum = 0): Expression {
    let left = this.primary();
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2 };
    for (;;) {
      const token = this.current();
      const strength = precedence[token.text] ?? -1;
      if (strength < minimum) break;
      this.advance();
      const right = this.expression(strength + 1);
      left = { kind: 'binary', operator: token.text as '+' | '-' | '*', left, right, token };
    }
    return left;
  }

  private primary(): Expression {
    const token = this.current();
    if (token.kind === 'number') {
      this.advance();
      return { kind: 'number', value: BigInt(token.text), token };
    }
    if (token.kind === 'identifier') {
      this.advance();
      if (this.current().text !== '(') return { kind: 'name', name: token.text, token };
      this.advance();
      const args: Expression[] = [];
      if (this.current().text !== ')') {
        do {
          args.push(this.expression());
          if (this.current().text !== ',') break;
          this.advance();
        } while (this.current().text !== ')');
      }
      this.expect(')');
      return { kind: 'call', name: token.text, args, token };
    }
    if (token.text === '(') {
      this.advance();
      const expression = this.expression();
      this.expect(')');
      return expression;
    }
    throw new WitnessScriptError('Expected a field expression.', token.start, token.end);
  }
}

export function parseWitnessScript(source: string): WitnessScriptProgram {
  return new Parser(tokenize(source)).parse();
}

function expressionPrecedence(expression: Expression): number {
  if (expression.kind !== 'binary') return 3;
  return expression.operator === '*' ? 2 : 1;
}

function printExpression(expression: Expression, parentPrecedence = 0): string {
  if (expression.kind === 'number') return expression.value.toString();
  if (expression.kind === 'name') return expression.name;
  if (expression.kind === 'call') return `${expression.name}(${expression.args.map((argument) => printExpression(argument)).join(', ')})`;
  const precedence = expressionPrecedence(expression);
  const rendered = `${printExpression(expression.left, precedence)} ${expression.operator} ${printExpression(expression.right, precedence + (expression.operator === '-' ? 1 : 0))}`;
  return precedence < parentPrecedence ? `(${rendered})` : rendered;
}

function printStatements(statements: readonly Statement[], depth: number): string[] {
  const indent = '  '.repeat(depth);
  return statements.flatMap((statement): string[] => {
    if (statement.kind === 'input') return [`${indent}${statement.visibility} ${statement.name}: field;`];
    if (statement.kind === 'let') return [`${indent}let ${statement.name} = ${printExpression(statement.expression)};`];
    if (statement.kind === 'assert') return [`${indent}assert ${printExpression(statement.left)} == ${printExpression(statement.right)};`];
    if (statement.kind === 'range') return [`${indent}range ${statement.name} in ${statement.lower}..${statement.upper};`];
    return [
      `${indent}for ${statement.name} in ${statement.lower}..${statement.upper} {`,
      ...printStatements(statement.body, depth + 1),
      `${indent}}`,
    ];
  });
}

/** Canonical formatter used by the parser round-trip gate and editor action. */
export function printWitnessScript(program: WitnessScriptProgram): string {
  return [`claim ${program.name} {`, ...printStatements(program.statements, 1), '}'].join('\n');
}

interface RangeDerivation {
  sourceName: string;
  lower: number;
  upper: number;
}

export interface CompiledWitnessScript {
  program: WitnessScriptProgram;
  circuit: Circuit;
  /** Source input names in proof/public-input order. */
  inputs: ReadonlyMap<string, number>;
  /** Maps source values to wires and validates lookup-range bounds. */
  deriveInputs(values: Readonly<Record<string, bigint>>): Map<number, bigint>;
}

class Lowerer {
  private readonly builder = new PresetBuilder();
  private readonly wires = new Map<string, number>();
  private readonly inputs = new Map<string, number>();
  private readonly ranges: RangeDerivation[] = [];
  private readonly constants = new Map<bigint, number>();

  private constant(value: bigint): number {
    const cached = this.constants.get(value);
    if (cached !== undefined) return cached;
    const wire = this.builder.constant(value);
    this.constants.set(value, wire);
    return wire;
  }

  private power7(value: number): number {
    const squared = this.builder.mul(value, value);
    const fourth = this.builder.mul(squared, squared);
    const sixth = this.builder.mul(fourth, squared);
    return this.builder.mul(sixth, value);
  }

  private subtract(left: number, right: number): number {
    return this.builder.add(left, this.builder.mul(right, this.constant(-1n)));
  }

  private async lowerPoseidon(left: number, right: number): Promise<number> {
    let state = [left, right, this.constant(0n)];
    const constants = await poseidonRoundConstants();
    const halfFull = POSEIDON_FULL_ROUNDS / 2;
    const totalRounds = POSEIDON_FULL_ROUNDS + POSEIDON_PARTIAL_ROUNDS;
    for (let round = 0; round < totalRounds; round++) {
      const full = round < halfFull || round >= halfFull + POSEIDON_PARTIAL_ROUNDS;
      state = state.map((wire, index) => this.builder.add(wire, this.constant(constants[round]![index]!)));
      state = state.map((wire, index) => full || index === 0 ? this.power7(wire) : wire);
      state = POSEIDON_MDS.map((row) => row.reduce((sum, coefficient, index) => this.builder.add(sum, this.builder.mul(this.constant(coefficient), state[index]!)), this.constant(0n)));
    }
    return state[0]!;
  }

  private async lowerExpression(expression: Expression, loopValues: ReadonlyMap<string, number>): Promise<number> {
    switch (expression.kind) {
      case 'number': return this.constant(expression.value);
      case 'name': {
        const loopValue = loopValues.get(expression.name);
        if (loopValue !== undefined) return this.constant(BigInt(loopValue));
        const wire = this.wires.get(expression.name);
        if (wire === undefined) throw new WitnessScriptError(`Unknown name ${JSON.stringify(expression.name)}.`, expression.token.start, expression.token.end);
        return wire;
      }
      case 'binary': {
        const left = await this.lowerExpression(expression.left, loopValues);
        const right = await this.lowerExpression(expression.right, loopValues);
        if (expression.operator === '+') return this.builder.add(left, right);
        if (expression.operator === '-') return this.subtract(left, right);
        return this.builder.mul(left, right);
      }
      case 'call': return this.lowerCall(expression, loopValues);
    }
  }

  private async lowerCall(expression: Extract<Expression, { kind: 'call' }>, loopValues: ReadonlyMap<string, number>): Promise<number> {
    if (expression.name === 'mimc') {
      if (expression.args.length !== 1) throw new WitnessScriptError('mimc expects exactly one field input.', expression.token.start, expression.token.end);
      const input = await this.lowerExpression(expression.args[0]!, loopValues);
      let state = input;
      for (let round = 0; round < 32; round++) state = this.power7(this.builder.add(state, this.constant(await mimcConstant(round))));
      return this.builder.add(state, input);
    }
    if (expression.name === 'poseidon') {
      if (expression.args.length !== 2) throw new WitnessScriptError('poseidon expects exactly two field inputs.', expression.token.start, expression.token.end);
      return this.lowerPoseidon(
        await this.lowerExpression(expression.args[0]!, loopValues),
        await this.lowerExpression(expression.args[1]!, loopValues),
      );
    }
    if (expression.name === 'merkle_path') {
      if (expression.args.length !== 3) throw new WitnessScriptError('merkle_path expects leaf, sibling, and a boolean direction.', expression.token.start, expression.token.end);
      const leaf = await this.lowerExpression(expression.args[0]!, loopValues);
      const sibling = await this.lowerExpression(expression.args[1]!, loopValues);
      const direction = await this.lowerExpression(expression.args[2]!, loopValues);
      this.builder.assertZero(this.builder.mul(direction, this.subtract(direction, this.constant(1n))));
      const left = this.builder.add(leaf, this.builder.mul(direction, this.subtract(sibling, leaf)));
      const right = this.builder.add(sibling, this.builder.mul(direction, this.subtract(leaf, sibling)));
      return this.lowerPoseidon(left, right);
    }
    throw new WitnessScriptError(`Unknown standard-library function ${JSON.stringify(expression.name)}.`, expression.token.start, expression.token.end);
  }

  private async lowerRange(statement: Extract<Statement, { kind: 'range' }>, loopValues: ReadonlyMap<string, number>): Promise<void> {
    if (loopValues.has(statement.name)) throw new WitnessScriptError('A range target must be an input or let binding, not a loop counter.', statement.token.start, statement.token.end);
    const source = this.wires.get(statement.name);
    if (source === undefined) throw new WitnessScriptError(`Unknown range target ${JSON.stringify(statement.name)}.`, statement.token.start, statement.token.end);
    this.builder.lookup(source);
    this.ranges.push({ sourceName: statement.name, lower: statement.lower, upper: statement.upper });
  }

  private async lowerStatements(statements: readonly Statement[], loopValues: ReadonlyMap<string, number>): Promise<void> {
    for (const statement of statements) {
      if (statement.kind === 'input') {
        if (loopValues.size > 0) throw new WitnessScriptError('Inputs must be declared outside a for loop.', statement.token.start, statement.token.end);
        if (this.wires.has(statement.name)) throw new WitnessScriptError(`Duplicate binding ${JSON.stringify(statement.name)}.`, statement.token.start, statement.token.end);
        const wire = statement.visibility === 'public' ? this.builder.pub() : this.builder.priv();
        this.wires.set(statement.name, wire);
        this.inputs.set(statement.name, wire);
        continue;
      }
      if (statement.kind === 'let') {
        if (this.wires.has(statement.name) || loopValues.has(statement.name)) throw new WitnessScriptError(`Duplicate binding ${JSON.stringify(statement.name)}.`, statement.token.start, statement.token.end);
        this.wires.set(statement.name, await this.lowerExpression(statement.expression, loopValues));
        continue;
      }
      if (statement.kind === 'assert') {
        const left = await this.lowerExpression(statement.left, loopValues);
        const right = await this.lowerExpression(statement.right, loopValues);
        this.builder.assertZero(this.subtract(left, right));
        continue;
      }
      if (statement.kind === 'range') {
        await this.lowerRange(statement, loopValues);
        continue;
      }
      for (let value = statement.lower; value <= statement.upper; value++) {
        const nested = new Map(loopValues);
        nested.set(statement.name, value);
        await this.lowerStatements(statement.body, nested);
      }
    }
  }

  async compile(program: WitnessScriptProgram): Promise<CompiledWitnessScript> {
    await this.lowerStatements(program.statements, new Map());
    const publicOrder = program.statements
      .flatMap((statement) => statement.kind === 'input' && statement.visibility === 'public' ? [this.inputs.get(statement.name)!] : []);
    const range = this.ranges[0];
    if (range !== undefined && this.ranges.some((candidate) => candidate.lower !== range.lower || candidate.upper !== range.upper)) {
      throw new WitnessScriptError('A circuit currently uses one fixed lookup table, so all range statements must share the same bounds.', 0, printWitnessScript(program).length);
    }
    const lookupTable = range === undefined ? undefined : Array.from({ length: range.upper - range.lower + 1 }, (_, index) => BigInt(range.lower + index));
    const circuit: Circuit = {
      ...this.builder.build(program.name, publicOrder, lookupTable),
      provenance: { kind: 'witness-script', source: printWitnessScript(program) },
    };
    const inputs = new Map(this.inputs);
    const ranges = this.ranges.map((candidate) => ({ ...candidate }));
    return {
      program,
      circuit,
      inputs,
      deriveInputs(values: Readonly<Record<string, bigint>>): Map<number, bigint> {
        const result = new Map<number, bigint>();
        for (const [name, wire] of inputs) {
          const value = values[name];
          if (value === undefined) throw new Error(`Witness Script input ${JSON.stringify(name)} is missing.`);
          result.set(wire, value);
        }
        for (const range of ranges) {
          const value = values[range.sourceName];
          if (value === undefined || value < BigInt(range.lower) || value > BigInt(range.upper)) {
            throw new Error(`${range.sourceName} must be in ${range.lower}..${range.upper}.`);
          }
        }
        return result;
      },
    };
  }
}

export async function compileWitnessScript(source: string): Promise<CompiledWitnessScript> {
  const program = parseWitnessScript(source);
  return new Lowerer().compile(program);
}
