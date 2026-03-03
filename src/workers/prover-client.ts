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
  | { action: 'grind'; circuit: Circuit; inputs: [number, string][]; weakQueries: number; maxAttempts: number };

function requestWorker<T extends WorkerResponse['kind']>(
  request: WorkerRequestBody,
  target: T,
  onProgress?: (stage: string) => void,
): Promise<Extract<WorkerResponse, { kind: T }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./prover.worker.ts', import.meta.url));
    const id = 1;
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.kind === 'progress') {
        onProgress?.(response.stage);
        return;
      }
      worker.terminate();
      if (response.kind === 'error') {
        reject(new Error(response.message));
      } else if (response.kind === target) {
        resolve(response as Extract<WorkerResponse, { kind: T }>);
      } else {
        reject(new Error(`Worker returned ${response.kind} for ${target}.`));
      }
    });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    });
    worker.postMessage({ ...request, id } as WorkerRequest);
  });
}

export async function proveInWorker(
  circuit: Circuit,
  inputs: Map<number, bigint>,
  params: Params,
  seed: number,
  onProgress?: (stage: string) => void,
): Promise<WorkerProofResult> {
  return requestWorker({ action: 'prove', circuit, inputs: [...inputs].map(([wire, value]) => [wire, value.toString()]), params, seed }, 'proof', onProgress);
}

export async function grindInWorker(
  circuit: Circuit,
  inputs: Map<number, bigint>,
  weakQueries: number,
  maxAttempts: number,
  onProgress?: (stage: string) => void,
): Promise<{ attempts: number; succeeded: boolean }> {
  return requestWorker({ action: 'grind', circuit, inputs: [...inputs].map(([wire, value]) => [wire, value.toString()]), weakQueries, maxAttempts }, 'grind', onProgress);
}
