import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const budgetKiB = Number(process.env.BUNDLE_BUDGET_KIB ?? 410);
const budgetBytes = budgetKiB * 1024;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filePath) : [filePath];
  });
}

function htmlRoot() {
  if (existsSync('out')) {
    const files = filesUnder('out').filter((file) => file.endsWith('.html'));
    if (files.length > 0) return { root: 'out', files };
  }

  const appRoot = join('.next', 'server', 'app');
  if (existsSync(appRoot)) {
    const files = filesUnder(appRoot).filter((file) => file.endsWith('.html'));
    if (files.length > 0) return { root: appRoot, files };
  }

  throw new Error(
    'Bundle budget found no exported or prerendered HTML. Run `npm run build` first.',
  );
}

const compressedSizes = new Map();
function compressedSize(filePath) {
  if (!compressedSizes.has(filePath)) {
    compressedSizes.set(filePath, gzipSync(readFileSync(filePath), { level: 9 }).byteLength);
  }
  return compressedSizes.get(filePath);
}

function resolveScript(reference, htmlFile) {
  const clean = reference.replace(/^\//, '');
  const nextIndex = clean.indexOf('_next/');
  const candidates = [];

  if (nextIndex >= 0) {
    const nextPath = clean.slice(nextIndex);
    candidates.push(join('out', nextPath));
    candidates.push(join('.next', nextPath.replace(/^_next\//, '')));
  }

  candidates.push(resolve(dirname(htmlFile), reference));
  return candidates.find(existsSync);
}

function referencedJavascript(htmlFile) {
  const html = readFileSync(htmlFile, 'utf8');
  const references = html.matchAll(/(?:src|href)=["']([^"'?#]+\.js)(?:[?#][^"']*)?["']/g);
  return new Set(
    [...references]
      .map((match) => resolveScript(match[1], htmlFile))
      .filter((filePath) => filePath !== undefined),
  );
}

const { root, files } = htmlRoot();
const routeSizes = files
  .map((htmlFile) => {
    const javascriptFiles = referencedJavascript(htmlFile);
    const bytes = [...javascriptFiles].reduce(
      (total, filePath) => total + compressedSize(filePath),
      0,
    );
    return {
      route: relative(root, htmlFile),
      bytes,
      files: javascriptFiles.size,
    };
  })
  .sort((left, right) => right.bytes - left.bytes);

const largestRoute = routeSizes[0];
const oversizedRoutes = routeSizes.filter(({ bytes }) => bytes > budgetBytes);

console.log(
  `Largest initial route JavaScript: ${(largestRoute.bytes / 1024).toFixed(1)} KiB gzip across ${largestRoute.files} files for ${largestRoute.route} (budget: ${budgetKiB} KiB per route; ${routeSizes.length} routes checked).`,
);

if (oversizedRoutes.length > 0) {
  for (const route of oversizedRoutes) {
    console.error(`- ${route.route}: ${(route.bytes / 1024).toFixed(1)} KiB gzip`);
  }
  process.exit(1);
}
