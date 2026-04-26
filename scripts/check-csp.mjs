import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// The shipped policy lives in three places that must never drift apart: the host
// config for Vercel, the host config for the local `serve` preview that the
// Playwright suite runs against, and the human-readable document an operator
// reads when deploying somewhere else. This script is what makes "must never
// drift" enforceable.
const DOC = 'docs/STATIC-HOST-HEADERS.md';
const VERCEL = 'vercel.json';
const SERVE = 'serve.json';

// `worker-src 'self'` is load-bearing, not boilerplate: the entire ZK prover
// runs in the Web Worker built by src/workers/prover-client.ts, so without it
// the product does nothing at all. `connect-src 'self'` is deliberate too —
// `'none'` would block App Router prefetch of same-origin route payloads.
const requiredDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
];

const requiredHeaders = [
  'Content-Security-Policy',
  'Referrer-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
];

function fail(message) {
  console.error(`CSP check failed: ${message}`);
  process.exit(1);
}

function headersFromConfig(filename, expectedSource) {
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  const blocks = config.headers ?? [];
  if (blocks.length !== 1) {
    fail(`${filename} must define exactly one header block — found ${blocks.length}.`);
  }
  if (blocks[0].source !== expectedSource) {
    fail(
      `${filename} header block source must be "${expectedSource}" — found "${blocks[0].source}".`,
    );
  }

  const headers = new Map();
  for (const { key, value } of blocks[0].headers ?? []) {
    if (headers.has(key)) fail(`${filename} defines ${key} twice.`);
    headers.set(key, value);
  }
  for (const key of requiredHeaders) {
    if (!headers.has(key)) fail(`${filename} is missing the ${key} header.`);
  }
  return headers;
}

// The document is the operator-facing copy of the same policy, written as a
// literal HTTP block so it can be diffed against the host configs rather than
// read for vibes.
function headersFromDoc(filename) {
  const source = readFileSync(filename, 'utf8');
  const block = source.match(/```http\n([\s\S]*?)```/);
  if (!block) fail(`${filename} has no \`\`\`http header block.`);

  const headers = new Map();
  for (const line of block[1].split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator === -1) fail(`${filename} header block has a line with no "key: value": ${line}`);
    headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

const vercelHeaders = headersFromConfig(VERCEL, '/(.*)');
const serveHeaders = headersFromConfig(SERVE, '**');
const docHeaders = headersFromDoc(DOC);

for (const key of requiredHeaders) {
  const vercel = vercelHeaders.get(key);
  if (serveHeaders.get(key) !== vercel) {
    fail(`${SERVE} and ${VERCEL} disagree on ${key}.`);
  }
  if (docHeaders.get(key) !== vercel) {
    fail(`${DOC} and ${VERCEL} disagree on ${key}.`);
  }
}

const policy = vercelHeaders.get('Content-Security-Policy');

for (const directive of requiredDirectives) {
  if (!policy.includes(directive)) fail(`CSP is missing required directive: ${directive}`);
}
if (/\*/.test(policy)) fail('CSP may not permit wildcard sources.');
if (/'unsafe-eval'|'unsafe-hashes'/.test(policy)) {
  fail('CSP may not permit unsafe execution tokens.');
}
if (/https?:|blob:/.test(policy)) {
  fail('CSP may not permit off-origin or blob sources — this product is same-origin only.');
}

// A policy that forbids off-origin loads is only meaningful if the export does
// not contain any. `out/` is git-ignored, so this half of the check is skipped
// when it has not been built — CI always builds first.
const OUT = 'out';

// Matching every absolute URL in the bundle produces false positives: the
// framework ships URL/URLSearchParams feature-detection probes such as
// `new URL("https://a@b")` that are constructed and discarded, never fetched.
// So each file type is scanned only for the forms that actually initiate a
// load, which is the thing the CSP governs.
const scanners = {
  // `src` on any tag is a subresource load. `href` only counts on <link>: an
  // <a href> to another site is a navigation the user chooses, which no CSP
  // fetch directive governs and which issues no request until clicked.
  '.html': [
    /\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+/gi,
    /<link\b[^>]*\bhref\s*=\s*["'](?:https?:)?\/\/[^"']+/gi,
  ],
  '.css': [/\burl\(\s*["']?(?:https?:)?\/\/[^)"']+/gi, /@import\s+["'](?:https?:)?\/\/[^"']+/gi],
  '.js': [
    /(?:\bfetch|\bimportScripts|\bimport|new\s+Worker|new\s+SharedWorker|new\s+WebSocket|new\s+EventSource)\s*\(\s*["'`](?:https?:)?\/\/[^"'`]+/g,
    /\.src\s*=\s*["'`](?:https?:)?\/\/[^"'`]+/g,
  ],
};
scanners['.mjs'] = scanners['.js'];

// XML/SVG namespace declarations are identifiers, not loads; nothing fetches
// them, and inline SVG puts them on an `xlink:href` that the HTML scanner sees.
const allowedOffOrigin = [/\/\/(?:www\.)?w3\.org\//i, /\/\/(?:www\.)?schema\.org\//i];
const scannedExtensions = new Set(Object.keys(scanners));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(filePath) : [filePath];
    }),
  );
  return nested.flat();
}

if (existsSync(OUT)) {
  const files = (await filesUnder(OUT)).filter((file) => scannedExtensions.has(path.extname(file)));
  const violations = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const pattern of scanners[path.extname(file)]) {
      for (const match of content.matchAll(pattern)) {
        const reference = match[0];
        if (allowedOffOrigin.some((allowed) => allowed.test(reference))) continue;
        violations.push(`${file}: ${reference}`);
      }
    }
  }

  if (violations.length > 0) {
    fail(
      `the built export references off-origin hosts, which this CSP forbids:\n${violations
        .slice(0, 20)
        .join('\n')}`,
    );
  }
  console.log(
    `CSP configuration is complete and consistent; ${files.length} exported files carry no off-origin reference.`,
  );
} else {
  console.log(
    `CSP configuration is complete and consistent; ${OUT}/ not built, export scan skipped.`,
  );
}
