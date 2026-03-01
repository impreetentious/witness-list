# Witness List — agent guardrails

- The gates are acceptance criteria; the negative (attack) suite Z9 is non-negotiable — the demo attacks and the CI attacks must be the same functions.
- `src/zk/` stays pure: no DOM, no React imports. Vitest runs it under node on purpose.
- Never overclaim security. "Conjectured", "teaching-scale", and the live readout formula are load-bearing product copy.
- All field-specific constants must match the fixtures (regenerate with tools/reference.py — never hand-edit fixtures).
- M4 is explicitly unsound-alone (no FRI yet); label it as such everywhere it surfaces.
- No new runtime dependencies without a decision-log row.
- Run `npm run typecheck && npm test` before considering any change complete.

## Commit convention

- Every logical commit increments the product version and uses `Commit vX.Y.Z: Title Case + Short Scope /N-F5-T6` as its subject.
- In the same commit, update the root `package.json` and `package-lock.json` version fields plus README's Product Version timestamp in IST.
- Never stage, commit, push, or open a PR unless the user asks.
