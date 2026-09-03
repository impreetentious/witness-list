/**
 * Z21 — honesty copy gate. Overclaiming is the one unforgivable bug:
 * scan load-bearing surfaces so "conjectured" / "teaching-scale" / the live
 * §4.11 formula / identity-only unsound-alone / ZK illustration wording cannot
 * regress silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...walkTsFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

describe('Z21: honesty copy cannot silently regress', () => {
  const security = read('src/app/security-readout.tsx');
  const workshop = read('src/app/workshop.tsx');
  const zkPanel = read('src/app/zk-panel.tsx');
  const page = read('src/app/page.tsx');
  const identityPreview = read('src/app/identity-preview.tsx');
  const prove = read('src/zk/plonk/prove.ts');
  const zkmode = read('src/zk/zkmode.ts');
  const lessons = read('src/course/lessons.ts');

  it('keeps conjectured + teaching-scale load-bearing on the live readout and hero', () => {
    expect(security).toMatch(/Conjectured teaching-scale bound/);
    expect(security).toMatch(/teaching-scale and conjectured/);
    expect(workshop).toMatch(/teaching-scale/);
    expect(workshop).toMatch(/conjectured/);
  });

  it('keeps the live §4.11 readout formula shape beside the parameters', () => {
    // The formula must remain computed from live params, not a static disclaimer.
    expect(security).toMatch(
      /ε ≈ max\(4n \/ \(p² − \|D\|\), \(1\/\{params\.blowup\}\)\^\{params\.queries\}, 2⁻³²\)/,
    );
    expect(security).toMatch(/params\.queries/);
    expect(security).toMatch(/params\.blowup/);
    expect(security).toMatch(/2⁻³²/);
  });

  it('labels the identity-only lesson unsound-alone wherever its surface appears', () => {
    expect(page).toMatch(/unsound alone/i);
    expect(identityPreview).toMatch(/Unsound alone/);
    expect(prove).toMatch(/UNSOUND ALONE/);
    expect(prove).toMatch(/unsound/);
  });

  it('keeps the ZK no-witness transcript an illustration, not a formal proof', () => {
    const required = 'illustration of the ZK definition, not a formal proof';
    expect(zkPanel).toContain('ZK_TRANSCRIPT_ILLUSTRATION_LABEL');
    expect(zkmode).toContain(required);
    expect(zkmode).toMatch(/export const ZK_TRANSCRIPT_ILLUSTRATION_LABEL/);
    expect(lessons).toMatch(/illustration, not a formal simulator proof/);
  });
});

describe('zk/ purity boundary', () => {
  it('imports nothing from React or the DOM', () => {
    const zkRoot = join(root, 'src/zk');
    const offenders: string[] = [];
    for (const file of walkTsFiles(zkRoot)) {
      const source = readFileSync(file, 'utf8');
      if (
        /\bfrom\s+['"]react(?:-dom)?(?:\/[^'"]*)?['"]/.test(source) ||
        /\bfrom\s+['"]react\/jsx-runtime['"]/.test(source) ||
        /\bdocument\./.test(source) ||
        /\bwindow\./.test(source) ||
        /\bHTMLElement\b/.test(source)
      ) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('zk/ formula citation discipline', () => {
  const kernels = [
    'src/zk/fp2-poly.ts',
    'src/zk/grinding.ts',
    'src/zk/poseidon.ts',
    'src/zk/poseidon-merkle.ts',
    'src/zk/plonk/lookup.ts',
    'src/zk/plonk/permutation-fp2.ts',
    'src/zk/plonk/prove-fp2.ts',
    'src/zk/plonk/quotient-fp2.ts',
    'src/zk/plonk/verify-fp2.ts',
    'src/zk/fri/fri-fp2.ts',
  ];

  it('keeps the protocol formulas linked to their spec sections', () => {
    for (const file of kernels) {
      const header = read(file).split('\n').slice(0, 4).join('\n');
      expect(header, file).toMatch(/PROTOCOL-SPEC\.md §(?:4\.|12)/);
    }
  });
});
