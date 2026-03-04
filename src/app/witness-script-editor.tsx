'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { compileWitnessScript, parseWitnessScript, printWitnessScript, WitnessScriptError } from '@/script/witness-script';
import type { CompiledWitnessScript } from '@/script/witness-script';
import { witnessScriptExamples } from '@/script/examples';

export interface WitnessScriptEditorProps {
  onUseScript: (compiled: CompiledWitnessScript, values: Record<string, bigint>) => void;
}

const witnessScriptLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^(claim|public|private|field|let|assert|range|in|for)\b/)) return 'keyword';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/)) return 'variableName.special';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    stream.next();
    return 'operator';
  },
});

export function WitnessScriptEditor({ onUseScript }: WitnessScriptEditorProps) {
  const initial = witnessScriptExamples[0]!;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourceRef = useRef(initial.source);
  const onUseScriptRef = useRef(onUseScript);
  const [source, setSource] = useState(initial.source);
  const [activeExample, setActiveExample] = useState(initial.id);
  const [status, setStatus] = useState('Choose an example or write a bounded claim, then compile it to the same circuit IR as the canvas.');
  const [compiled, setCompiled] = useState<CompiledWitnessScript>();

  useEffect(() => { onUseScriptRef.current = onUseScript; }, [onUseScript]);

  useEffect(() => {
    if (host.current === null) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: sourceRef.current,
        extensions: [
          keymap.of([...defaultKeymap, indentWithTab]),
          witnessScriptLanguage,
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            sourceRef.current = next;
            setSource(next);
            setCompiled(undefined);
            setStatus('Source changed. Compile to check syntax, bounded ranges, and circuit lowering.');
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void compileSource(true, true);
    }, 450);
    return () => window.clearTimeout(timer);
    // `compileSource` reads the latest source ref; source is the debounce key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, activeExample]);

  function loadExample(id: string): void {
    const example = witnessScriptExamples.find((candidate) => candidate.id === id);
    if (example === undefined) return;
    setActiveExample(id);
    sourceRef.current = example.source;
    setSource(example.source);
    setCompiled(undefined);
    setStatus(`${example.title} loaded. Compile it to inspect its generated circuit.`);
    const view = viewRef.current;
    if (view !== null) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: example.source } });
  }

  function exampleValues(result: CompiledWitnessScript): Record<string, bigint> {
    const example = witnessScriptExamples.find((candidate) => candidate.id === activeExample);
    return example === undefined
      ? Object.fromEntries([...result.inputs.keys()].map((name) => [name, 0n]))
      : example.inputs;
  }

  async function compileSource(useInWorkshop: boolean, automatic = false): Promise<void> {
    try {
      const result = await compileWitnessScript(sourceRef.current);
      const values = exampleValues(result);
      result.deriveInputs(values);
      setCompiled(result);
      setStatus(`Compiled ${result.circuit.gates.length} circuit gates (n will be chosen by the compiler). ${useInWorkshop ? automatic ? 'Live canvas preview synchronized.' : 'Loaded into the proof workshop.' : 'The claim is ready to load.'}`);
      if (useInWorkshop) onUseScriptRef.current(result, values);
    } catch (caught) {
      setCompiled(undefined);
      if (caught instanceof WitnessScriptError) {
        const { start, end } = caught.diagnostic;
        viewRef.current?.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
        setStatus(`${caught.message} Source span ${start}–${end}.`);
      } else {
        setStatus(caught instanceof Error ? caught.message : 'Witness Script could not be compiled.');
      }
    }
  }

  function formatSource(): void {
    try {
      const formatted = printWitnessScript(parseWitnessScript(sourceRef.current));
      const view = viewRef.current;
      if (view !== null) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : 'Witness Script could not be formatted.');
    }
  }

  return (
    <section className="witness-script" aria-labelledby="script-title">
      <div className="script-heading">
        <div>
          <p className="eyebrow">Phase 3 · Witness Script</p>
          <h2 id="script-title">Write a claim, then inspect its circuit</h2>
          <p>Inputs, lookup-backed ranges, arithmetic assertions, and bounded loops compile to the same seven-operation IR. There is no recursion or unbounded execution.</p>
        </div>
        <label>Example <select value={activeExample} onChange={(event) => loadExample(event.target.value)}>{witnessScriptExamples.map((example) => <option key={example.id} value={example.id}>{example.title}</option>)}</select></label>
      </div>
      <div className="script-editor" ref={host} />
      <div className="script-actions">
        <button type="button" onClick={() => void compileSource(false)}>Compile Script</button>
        <button type="button" onClick={() => void compileSource(true)}>Use in Workshop</button>
        <button type="button" onClick={formatSource}>Format</button>
      </div>
      <p className={compiled === undefined ? 'canvas-status' : 'pass canvas-status'} aria-live="polite">{status}</p>
      <p className="mono">{source.length} source bytes · calls: <code>mimc(x)</code>, <code>poseidon(left, right)</code>, <code>merkle_path(leaf, sibling, direction)</code> · range bounds are inclusive.</p>
    </section>
  );
}
