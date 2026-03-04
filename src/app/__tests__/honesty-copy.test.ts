/**
 * Z21 — honesty copy gate. Overclaiming is the one unforgivable bug:
 * scan load-bearing surfaces so "conjectured" / "teaching-scale" / the live
 * §4.11 formula / M4 unsound-alone / ZK illustration wording cannot regress silently.
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
  const m4 = read('src/app/m4-preview.tsx');
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
    expect(security).toMatch(/ε ≈ max\(3n \/ \(p² − \|D\|\), \(1\/\{params\.blowup\}\)\^\{params\.queries\}, 2⁻³²\)/);
    expect(security).toMatch(/params\.queries/);
    expect(security).toMatch(/params\.blowup/);
    expect(security).toMatch(/2⁻³²/);
  });

  it('labels M4 unsound-alone wherever the M4 surface appears', () => {
    expect(page).toMatch(/unsound alone/i);
    expect(m4).toMatch(/Unsound alone/);
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
        /\bfrom\s+['"]react(?:-dom)?(?:\/[^'"]*)?['"]/.test(source)
        || /\bfrom\s+['"]react\/jsx-runtime['"]/.test(source)
        || /\bdocument\./.test(source)
        || /\bwindow\./.test(source)
        || /\bHTMLElement\b/.test(source)
      ) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
