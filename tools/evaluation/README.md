# Development evaluation harness

Run from the checkout with Node 22+ and npm dependencies installed:

```sh
npm run eval -- --help
npm run eval -- dogfood --help
npm run eval -- simulate window --help
npm run eval -- simulate compare --help
npm run eval -- gate m1 --help
```

Append an explicit `--config ABS_PATH` to operations. Development and tests use
synthetic course fixtures; do not use real Canvas accounts or student vaults.
The runner adds experiment commands to the normal CLI in memory. It is neither
compiled into `dist` nor included in the npm package. `npm run typecheck` checks
both source and tooling; tests for this harness live in `test/tooling`.

Dogfood and sweeps exercise workflows with explicit host/human stops. Windows
plan frozen tasks across cutoffs. Comparisons, review feedback and M1 reports
assemble evidence for a human verdict; they never generate content or auto-grade.
All saved IDs, private journal paths, schemas and source hashes remain unchanged.
Resume or inspect existing records rather than creating replacements.

The installed CLI retains `simulate` capture/replay and task operations under
`src/simulation`, including read-only retrieval of existing completed outputs.
Private course feedback and older learning-history readers remain in `src/feedback`.
The legacy `cost report` journal slot is skipped without reopening exports.
Earlier checkpoints retain their recorded bytes; resume does not reverify billing.
