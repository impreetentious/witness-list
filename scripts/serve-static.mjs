/**
 * Serves the built `out/` the way the deployed host does, including the
 * `BASE_PATH` prefix CI builds with. The Playwright suite points at this rather
 * than `next dev` on purpose: the shipped artifact is a static export served
 * under a subpath, and base-path breakage — wrong asset URLs, dead internal
 * links, and above all a ZK prover Web Worker whose script URL no longer
 * resolves — is invisible to a dev server running at the root.
 *
 * Ported from limit-state/scripts/serve-static.mjs, which solved the identical
 * deployment shape.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'out');
const port = Number.parseInt(process.env.PORT ?? '3011', 10);
const host = process.env.HOST ?? '127.0.0.1';
const basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, '');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
]);

function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = join(candidate, 'index.html');
    if (existsSync(index)) return index;
  }

  const html = `${candidate}.html`;
  if (existsSync(html)) return html;

  if (extname(decoded)) return null;
  return join(root, 'index.html');
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  let pathname = url.pathname;
  if (basePath) {
    if (pathname === '/') {
      response.writeHead(302, { Location: `${basePath}/` });
      response.end();
      return;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    pathname = pathname.slice(basePath.length) || '/';
  }
  const file = resolveRequest(pathname);

  if (!file || !existsSync(file)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}`);
});
