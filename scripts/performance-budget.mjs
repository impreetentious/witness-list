import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const shellMaxBytes = Number(process.env.PERF_SHELL_MAX_KIB ?? 40) * 1024;
const scriptMaxCount = Number(process.env.PERF_SCRIPT_MAX_COUNT ?? 16);
const preloadMaxCount = Number(process.env.PERF_PRELOAD_MAX_COUNT ?? 3);

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
    'Performance budget found no exported or prerendered HTML. Run `npm run build` first.',
  );
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

const { root, files } = htmlRoot();
let failed = false;

for (const filePath of files) {
  const html = readFileSync(filePath, 'utf8');
  const shellBytes = Buffer.byteLength(html, 'utf8');
  const scriptCount = count(html, /<script\b/gi);
  const preloadCount = count(html, /<link[^>]+rel=["']preload["']/gi);
  const externalStylesheet = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:\/\//i.test(
    html,
  );
  const problems = [];

  if (shellBytes > shellMaxBytes) {
    problems.push(
      `HTML shell ${(shellBytes / 1024).toFixed(1)} KiB exceeds ${(shellMaxBytes / 1024).toFixed(0)} KiB.`,
    );
  }
  if (scriptCount > scriptMaxCount)
    problems.push(`script tags ${scriptCount} exceeds ${scriptMaxCount}.`);
  if (preloadCount > preloadMaxCount)
    problems.push(`preloads ${preloadCount} exceeds ${preloadMaxCount}.`);
  if (externalStylesheet) problems.push('external stylesheet found.');

  console.log(
    `${relative(root, filePath)}: ${(shellBytes / 1024).toFixed(1)} KiB, ${scriptCount} scripts, ${preloadCount} preloads.`,
  );

  if (problems.length > 0) {
    failed = true;
    for (const problem of problems) console.error(`- ${relative(root, filePath)}: ${problem}`);
  }
}

if (failed) process.exit(1);
