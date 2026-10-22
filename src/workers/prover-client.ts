'use client';

import type { Circuit } from '../zk/circuit/ir';
import type { Params, ProofTrace, VerifyResult } from '../zk/types';
import type { WorkerRequest, WorkerResponse } from './prover.worker';

export interface WorkerProofResult {
  trace: ProofTrace;
  result: VerifyResult;
}

type WorkerRequestBody =
  | { action: 'prove'; circuit: Circuit; inputs: [number, string][]; params: Params; seed: number }
  | {
      action: 'grind';
      circuit: Circuit;
      inputs: [number, string][];
      weakQueries: number;
      maxAttempts: number;
    };

function requestWorker<T extends WorkerResponse['kind']>(
  request: WorkerRequestBody,
  target: T,
  onProgress?: (stage: string) => void,
  signal?: AbortSignal,
): Promise<Extract<WorkerResponse, { kind: T }>> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Proof request cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./prover.worker.ts', import.meta.url));
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const id = 1;
    const cleanup = () => {
      worker.removeEventListener('message', message);
      worker.removeEventListener('error', error);
      worker.removeEventListener('messageerror', messageError);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abort = () => fail(new DOMException('Proof request cancelled.', 'AbortError'));
    const error = (event: ErrorEvent) =>
      fail(event.error instanceof Error ? event.error : new Error(event.message));
    const messageError = () => fail(new Error('Proof worker message could not be decoded.'));
    const message = (event: MessageEvent<WorkerResponse>) => {
      if (settled) return;
      const response = event.data;
      if (response === null || typeof response !== 'object') {
        fail(new Error('Invalid proof worker response.'));
        return;
      }
      if (response.id !== id) return;
      if (response.kind === 'progress') {
        onProgress?.(response.stage);
        return;
      }
      if (response.kind === 'error') {
        fail(new Error(response.message));
        return;
      }
      if (response.kind !== target) {
        fail(new Error(`Worker returned ${response.kind} for ${target}.`));
        return;
      }
      settled = true;
      cleanup();
      resolve(response as Extract<WorkerResponse, { kind: T }>);
    };
    worker.addEventListener('message', message);
    worker.addEventListener('error', error);
    worker.addEventListener('messageerror', messageError);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ ...request, id } as WorkerRequest);
    } catch (reason) {
      fail(reason);
    }
  });
}

export async function proveInWorker(
  circuit: Circuit,
  inputs: Map<number, bigint>,
  params: Params,
  seed: number,
  onProgress?: (stage: string) => void,
  signal?: AbortSignal,
): Promise<WorkerProofResult> {
  return requestWorker(
    {
      action: 'prove',
      circuit,
      inputs: [...inputs].map(([wire, value]) => [wire, value.toString()]),
      params,
      seed,
    },
    'proof',
    onProgress,
    signal,
  );
}

export async function grindInWorker(
  circuit: Circuit,
  inputs: Map<number, bigint>,
  weakQueries: number,
  maxAttempts: number,
  onProgress?: (stage: string) => void,
  signal?: AbortSignal,
): Promise<{ attempts: number; succeeded: boolean }> {
  return requestWorker(
    {
      action: 'grind',
      circuit,
      inputs: [...inputs].map(([wire, value]) => [wire, value.toString()]),
      weakQueries,
      maxAttempts,
    },
    'grind',
    onProgress,
    signal,
  );
}
