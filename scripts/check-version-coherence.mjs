#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const errors = [];

function markerVersion(file) {
  const source = read(file);
  return source.match(
    /\*\*(?:Release version|Portfolio Version|Product Version|Version):\*\*\s*`?v?([0-9]+\.[0-9]+\.[0-9]+)[^`\n]*/,
  )?.[1];
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
}

for (const file of ['README.md']) {
  const found = markerVersion(file);
  if (!found) errors.push(`${file} missing **Version:** vX.Y.Z marker`);
  else if (found !== version) errors.push(`${file} version ${found} != package.json ${version}`);
}


if (errors.length) {
  console.error('version-coherence FAILED:');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log(`version-coherence OK — ${version}`);
