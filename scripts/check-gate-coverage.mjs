import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateFile = join(root, 'gates.json');
let declarations;
try {
  declarations = JSON.parse(readFileSync(gateFile, 'utf8'));
} catch (error) {
  throw new Error(`check:gates could not read ${gateFile}: ${error.message}`, { cause: error });
}

if (!Array.isArray(declarations) || declarations.length === 0) {
  throw new Error('check:gates found no gate declarations in gates.json.');
}

const declared = new Map();
for (const declaration of declarations) {
  const { id, titleCount = 1 } = declaration ?? {};
  if (!/^Z\d+$/.test(id) || !Number.isInteger(titleCount) || titleCount < 1) {
    throw new Error(`check:gates found an invalid declaration: ${JSON.stringify(declaration)}`);
  }
  if (declared.has(id)) throw new Error(`check:gates found a duplicate declaration for ${id}.`);
  declared.set(id, titleCount);
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const testFiles = filesUnder(join(root, 'src'))
  .filter((file) => /[/\\]__tests__[/\\].+\.(ts|tsx)$/.test(file))
  .sort();
const titleCounts = new Map([...declared.keys()].map((gate) => [gate, 0]));
const titlePattern = /\b(?:describe|it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
for (const file of testFiles) {
  const source = readFileSync(file, 'utf8');
  for (const title of source.matchAll(titlePattern)) {
    for (const match of title[2].matchAll(/\bZ(\d+)\b/g)) {
      const gate = `Z${match[1]}`;
      if (titleCounts.has(gate)) titleCounts.set(gate, titleCounts.get(gate) + 1);
    }
  }
}

const incorrectCounts = [...declared].flatMap(([gate, expected]) => {
  const actual = titleCounts.get(gate);
  return actual === expected ? [] : [`${gate} (${actual}/${expected} titled test blocks)`];
});
if (incorrectCounts.length > 0) {
  console.error(`Incorrect executable gate labels: ${incorrectCounts.join(', ')}`);
  process.exit(1);
}

console.log(`gate-coverage OK — ${declared.size} declared Z-gates labelled in test titles`);
