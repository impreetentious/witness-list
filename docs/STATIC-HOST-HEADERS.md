# Static-host security headers

Witness List is a static client-side application. Every proof is generated and verified in the
browser; there is no backend, no telemetry, and no third-party embed. The policy below makes that
architectural claim enforceable by the host rather than merely asserted in prose.

`vercel.json` applies these headers on Vercel and `serve.json` carries the identical policy for any
host that reads that format. Both GitHub Pages and GitLab Pages serve this export under a
`BASE_PATH` prefix and neither reads these files, so on those hosts the headers must be configured
at the host level — see "Applying this on Pages" below. Any alternate static host should apply the
equivalent response headers to every route and static asset:

```http
Content-Security-Policy: default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data:; manifest-src 'self'; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
```

## Why each non-obvious directive is what it is

- **`worker-src 'self'`** — the whole product runs off the main thread. `src/workers/prover-client.ts`
  constructs a Web Worker from a bundler-emitted same-origin chunk, and without this directive the
  prover never starts: the app degrades to an inert page. It must never be widened beyond `'self'`,
  and in particular never to `blob:`. This is the single directive most worth re-checking after any
  bundler or framework upgrade, because the worker chunk's URL is emitted by the build.
- **`connect-src 'self'`** — the prover opens no connections of its own, so `'none'` looks tempting.
  It is wrong here: the App Router prefetches same-origin route payloads, and `'none'` would block
  that. `'self'` still forbids every off-origin destination, which is the property that matters —
  and it is what keeps the "nothing leaves the browser" claim true.
- **`font-src 'self'`** — Inter and JetBrains Mono are bundled through `@fontsource`, so they are
  same-origin assets. No font CDN is contacted, and none may be.
- **`script-src`/`style-src` inline allowances** — required by the framework's static bootstrap and
  its generated critical styles. They permit no remote origin.
- **`frame-ancestors 'none'` plus `X-Frame-Options: DENY`** — there is no embeddable surface. Both
  are set because some hosts and older agents honour only one.

## Applying this on Pages

GitHub Pages and GitLab Pages do not support custom response headers. Deploying there means the
policy above is documentation rather than enforcement, and the deployment is only as strong as the
host allows. If enforced headers matter for the chosen public URL, deploy behind a host that can
set them — Vercel, Netlify, Cloudflare Pages, or any reverse proxy — rather than assuming this file
takes effect.

## Changing this policy

`npm run check:csp` fails if `vercel.json`, `serve.json`, and this document disagree, if a required
directive goes missing, if a wildcard or unsafe execution token appears, or if the built `out/`
gains an off-origin reference. Update all three together, then re-run `npm run build && npm run
test:e2e` — the suite serves the built export under the deployed `BASE_PATH`, so a policy that
breaks the prover worker fails the gate rather than shipping.

Host-specific tuning and verification of the deployed response headers remain an owner step at
deploy time; nothing here has been checked against a live host.
