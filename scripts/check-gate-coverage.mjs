import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const declared = new Set([
  'Z1',
  'Z2',
  'Z3',
  'Z4',
  'Z5',
  'Z6',
  'Z7',
  'Z8',
  'Z9',
  'Z10',
  'Z11',
  'Z12',
  'Z13',
  'Z14',
  'Z15',
  'Z16',
  'Z17',
  'Z18',
  'Z19',
  'Z20',
  'Z21',
]);

function filesUnder(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const testText = filesUnder('src')
  .filter((file) => /[/\\]__tests__[/\\].+\.(ts|tsx)$/.test(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const covered = new Set([...testText.matchAll(/\bZ(\d+)\b/g)].map((match) => `Z${match[1]}`));
const missing = [...declared].filter((gate) => !covered.has(gate));

if (missing.length > 0) {
  console.error(`Missing executable gate labels: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`gate-coverage OK — ${declared.size} declared Z-gates labelled in src/**/__tests__`);
