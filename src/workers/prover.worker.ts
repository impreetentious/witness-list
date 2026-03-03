/// <reference lib="webworker" />
/** Browser-only prover orchestration. The protocol kernel remains DOM-free. */
import { compile, generateWitness } from '../zk/circuit/compile';
import type { Circuit } from '../zk/circuit/ir';
import { mod } from '../zk/field';
import { grindChallenge } from '../zk/attacks';
import { prove } from '../zk/plonk/prove';
import { verify } from '../zk/plonk/verify';
import type { Params, ProofTrace, VerifyResult } from '../zk/types';

export type WorkerRequest =
  | { id: number; action: 'prove'; circuit: Circuit; inputs: [number, string][]; params: Params; seed: number }
  | { id: number; action: 'grind'; circuit: Circuit; inputs: [number, string][]; weakQueries: number; maxAttempts: number };

export type WorkerResponse =
  | { id: number; kind: 'progress'; stage: string }
  | { id: number; kind: 'proof'; trace: ProofTrace; result: VerifyResult }
  | { id: number; kind: 'grind'; attempts: number; succeeded: boolean }
  | { id: number; kind: 'error'; message: string };

function inputsFrom(entries: [number, string][]): Map<number, bigint> {
  return new Map(entries.map(([wire, value]) => [wire, mod(BigInt(value))]));
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  const inputs = inputsFrom(request.inputs);
  if (request.action === 'grind') {
    const result = await grindChallenge(request.circuit, inputs, request.weakQueries, request.maxAttempts);
    return { id: request.id, kind: 'grind', ...result };
  }
  postMessage({ id: request.id, kind: 'progress', stage: 'Compiling circuit and generating witness…' } satisfies WorkerResponse);
  const circuit = await compile(request.circuit);
  postMessage({ id: request.id, kind: 'progress', stage: 'Committing trace, quotient, and FRI layers…' } satisfies WorkerResponse);
  const publicInputs = request.circuit.publicOrder.map((wire) => {
    const value = inputs.get(wire);
    if (value === undefined) throw new Error(`missing public input wire ${wire}`);
    return value;
  });
  const trace = await prove(circuit, generateWitness(request.circuit, inputs), publicInputs, request.params, request.seed);
  postMessage({ id: request.id, kind: 'progress', stage: 'Replaying verifier checklist…' } satisfies WorkerResponse);
  return { id: request.id, kind: 'proof', trace, result: await verify(circuit, trace.proof) };
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data)
    .then((response) => postMessage(response))
    .catch((caught: unknown) => postMessage({
      id: event.data.id,
      kind: 'error',
      message: caught instanceof Error ? caught.message : 'Worker failed to produce a proof.',
    } satisfies WorkerResponse));
});
