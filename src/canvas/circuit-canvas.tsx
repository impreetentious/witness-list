'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { compile } from '@/zk/circuit/compile';
import type { Circuit, GateOp } from '@/zk/circuit/ir';
import { pythagorean } from '@/zk/circuit/presets/pythagorean';

type GateData = {
  op: GateOp;
  value?: string;
};
type GateNode = Node<GateData, 'gate'>;

const arity: Record<GateOp, number> = {
  pub: 0,
  priv: 0,
  const: 0,
  add: 2,
  mul: 2,
  assert0: 1,
};

const labels: Record<GateOp, string> = {
  pub: 'Public input',
  priv: 'Private input',
  const: 'Constant',
  add: 'Add',
  mul: 'Multiply',
  assert0: 'Assert zero',
};

function fromCircuit(circuit: Circuit): { nodes: GateNode[]; edges: Edge[] } {
  return {
    nodes: circuit.gates.map((gate) => ({
      id: String(gate.id),
      type: 'gate',
      position: gate.pos ?? { x: 80 + gate.id * 24, y: 100 + (gate.id % 5) * 96 },
      data: { op: gate.op, value: gate.value?.toString() },
    })),
    edges: circuit.gates.flatMap((gate) => gate.inputs.map((input, inputIndex) => ({
      id: `${input}-${gate.id}-${inputIndex}`,
      source: String(input),
      target: String(gate.id),
      targetHandle: `input-${inputIndex}`,
      animated: false,
    }))),
  };
}

function GateCard({ data, selected }: NodeProps<GateNode>) {
  const inputs = arity[data.op];
  return (
    <div className={`gate-card gate-${data.op} ${selected ? 'selected' : ''}`}>
      {Array.from({ length: inputs }, (_, input) => (
        <Handle
          key={input}
          id={`input-${input}`}
          type="target"
          position={Position.Left}
          style={{ top: `${((input + 1) / (inputs + 1)) * 100}%` }}
        />
      ))}
      <span className="gate-op">{data.op}</span>
      <strong>{labels[data.op]}</strong>
      {data.op === 'const' && <small>value {data.value ?? '0'}</small>}
      {data.op === 'assert0' && <small>terminal statement</small>}
      {data.op !== 'assert0' && <Handle id="output" type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = { gate: GateCard };

function parseGateId(id: string): number {
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid canvas gate id ${id}`);
  return parsed;
}

function canvasCircuit(nodes: GateNode[], edges: Edge[]): Circuit {
  const edgeByTarget = new Map<string, Map<number, Edge>>();
  for (const edge of edges) {
    const input = /^input-(\d+)$/.exec(edge.targetHandle ?? '');
    if (input === null) continue;
    const inputIndex = Number(input[1]);
    const byInput = edgeByTarget.get(edge.target) ?? new Map<number, Edge>();
    if (byInput.has(inputIndex)) throw new Error(`Gate ${edge.target} has two wires connected to input ${inputIndex + 1}`);
    byInput.set(inputIndex, edge);
    edgeByTarget.set(edge.target, byInput);
  }
  const gates = nodes.map((node) => {
    const expectedInputs = arity[node.data.op];
    const inputs = Array.from({ length: expectedInputs }, (_, input) => {
      const edge = edgeByTarget.get(node.id)?.get(input);
      if (edge === undefined) throw new Error(`${labels[node.data.op]} gate ${node.id} is missing input ${input + 1}`);
      return parseGateId(edge.source);
    });
    let value: bigint | undefined;
    if (node.data.op === 'const') {
      try {
        value = BigInt(node.data.value ?? '0');
      } catch {
        throw new Error(`Constant gate ${node.id} needs an integer value`);
      }
    }
    return {
      id: parseGateId(node.id),
      op: node.data.op,
      inputs,
      value,
      pos: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    };
  });
  return {
    name: 'Canvas circuit',
    gates,
    publicOrder: nodes.filter((node) => node.data.op === 'pub').map((node) => parseGateId(node.id)),
  };
}

const pythagoreanCanvas = fromCircuit(pythagorean);

export function CircuitCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<GateNode>(pythagoreanCanvas.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(pythagoreanCanvas.edges);
  const [selectedId, setSelectedId] = useState<string>();
  const [compileStatus, setCompileStatus] = useState<string>('Pythagorean preset loaded. You can move gates, reconnect wires, or start empty.');

  const addGate = useCallback((op: GateOp) => {
    setNodes((current) => {
      const highestId = current.reduce((highest, node) => Math.max(highest, parseGateId(node.id)), 0);
      const id = String(highestId + 1);
      const gate: GateNode = {
        id,
        type: 'gate',
        position: { x: 120 + (current.length % 4) * 180, y: 90 + (current.length % 5) * 110 },
        data: { op, value: op === 'const' ? '0' : undefined },
      };
      setSelectedId(id);
      return [...current, gate];
    });
  }, [setNodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null || connection.targetHandle === null) return;
    setEdges((current) => addEdge({ ...connection, id: `${connection.source}-${connection.target}-${connection.targetHandle}` }, current));
  }, [setEdges]);

  const selected = nodes.find((node) => node.id === selectedId);
  const selectedConst = selected?.data.op === 'const' ? selected : undefined;

  const compileCanvas = useCallback(async () => {
    try {
      const circuit = canvasCircuit(nodes, edges);
      const compiled = await compile(circuit);
      setCompileStatus(`Compiled ${compiled.rows.length} PLONK rows (n = ${compiled.n}); circuit digest is bound into the proof transcript.`);
    } catch (caught) {
      setCompileStatus(caught instanceof Error ? caught.message : 'The canvas could not be compiled.');
    }
  }, [edges, nodes]);

  const reset = useCallback((preset: boolean) => {
    const next = preset ? fromCircuit(pythagorean) : { nodes: [] as GateNode[], edges: [] as Edge[] };
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedId(undefined);
    setCompileStatus(preset ? 'Pythagorean preset reloaded.' : 'Empty canvas. Add gates from the palette, then connect each input handle.');
  }, [setEdges, setNodes]);

  const updateConstant = useCallback((value: string) => {
    if (selectedConst === undefined) return;
    setNodes((current) => current.map((node) => node.id === selectedConst.id
      ? { ...node, data: { ...node.data, value } }
      : node));
  }, [selectedConst, setNodes]);

  const palette = useMemo(() => (Object.keys(labels) as GateOp[]), []);
  return (
    <section className="circuit-workbench" aria-labelledby="canvas-title">
      <div className="canvas-heading">
        <div>
          <p className="eyebrow">M6 circuit workbench</p>
          <h2 id="canvas-title">Build the claim before proving it</h2>
          <p>
            Every wire is a copy-constraint class. Connect a gate&apos;s output to an input handle,
            then compile the visible graph into deterministic PLONK rows.
          </p>
        </div>
        <div className="canvas-actions">
          <button type="button" onClick={compileCanvas}>Compile Canvas</button>
          <button type="button" onClick={() => reset(true)}>Load Pythagorean</button>
          <button type="button" onClick={() => reset(false)}>Start Empty</button>
        </div>
      </div>
      <div className="canvas-layout">
        <aside className="gate-palette" aria-label="Gate palette">
          <h3>Gate palette</h3>
          {palette.map((op) => (
            <button key={op} type="button" onClick={() => addGate(op)}>
              <code>{op}</code> {labels[op]}
            </button>
          ))}
          {selectedConst !== undefined && (
            <label className="constant-editor">
              Constant value
              <input value={selectedConst.data.value ?? '0'} onChange={(event) => updateConstant(event.target.value)} inputMode="numeric" />
            </label>
          )}
        </aside>
        <div className="flow-shell">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(undefined)}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
            aria-label="Circuit canvas"
          >
            <Background gap={20} size={1} />
            <MiniMap zoomable pannable />
            <Controls />
          </ReactFlow>
        </div>
      </div>
      <p className={compileStatus.startsWith('Compiled') ? 'pass canvas-status' : 'canvas-status'}>{compileStatus}</p>
    </section>
  );
}
