#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every release-version surface is listed here; adding a new one means adding it here too.
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const errors = [];
const EXPECTED = {
  nvmrc: '22.22.2',
  engines: '>=22.22.2 <23',
  workflow: '.github/workflows/ci.yml',
  ciNode: '22.22.2',
  gitlabImage: 'node:22.22.2',
};

function markerVersion(file) {
  const source = read(file);
  return source.match(/\*\*Version:\*\*\s*`?v?([0-9]+\.[0-9]+\.[0-9]+)[^`\n]*/)?.[1];
}

if (!version) errors.push('package.json missing version');

if (existsSync(path.join(root, 'package-lock.json'))) {
  const lock = JSON.parse(read('package-lock.json'));
  if (lock.version !== version) {
    errors.push(`package-lock.json version ${lock.version} != package.json ${version}`);
  }
  if (lock.packages?.['']?.version !== version) {
    errors.push(`package-lock packages[""].version ${lock.packages?.['']?.version} != ${version}`);
  }
} else if (existsSync(path.join(root, 'pnpm-lock.yaml'))) {
  const pnpmLock = read('pnpm-lock.yaml');
  if (!/^\s{2}\.:\s*$/m.test(pnpmLock)) errors.push('pnpm-lock.yaml missing the root importer');
} else {
  errors.push('missing package-lock.json or pnpm-lock.yaml');
}

// README.md, package.json, and the lockfile root are the release-version surfaces.
for (const file of ['README.md']) {
  const found = markerVersion(file);
  if (!found) errors.push(`${file} missing **Version:** vX.Y.Z marker`);
  else if (found !== version) errors.push(`${file} version ${found} != package.json ${version}`);
}

const nvm = read('.nvmrc').trim();
if (nvm !== EXPECTED.nvmrc) errors.push(`.nvmrc ${nvm} != ${EXPECTED.nvmrc}`);
if (pkg.engines?.node !== EXPECTED.engines) {
  errors.push(`package.json engines.node ${pkg.engines?.node} != ${EXPECTED.engines}`);
}
const workflow = read(EXPECTED.workflow);
const ciNodeFile = workflow.match(/^\s*node-version-file:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
if (ciNodeFile) {
  if (ciNodeFile !== '.nvmrc')
    errors.push(`${EXPECTED.workflow} node-version-file ${ciNodeFile} != .nvmrc`);
} else {
  const ciNode = workflow.match(/^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
  if (ciNode !== EXPECTED.ciNode) {
    errors.push(`${EXPECTED.workflow} node-version ${ciNode ?? 'missing'} != ${EXPECTED.ciNode}`);
  }
}

const gitlabImage = read('.gitlab-ci.yml').match(/^image:\s*([^\s]+)/m)?.[1];
if (gitlabImage !== EXPECTED.gitlabImage) {
  errors.push(`.gitlab-ci.yml image ${gitlabImage ?? 'missing'} != ${EXPECTED.gitlabImage}`);
}

if (errors.length) {
  console.error('version-coherence FAILED:');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log(`version-coherence OK — ${version}`);
