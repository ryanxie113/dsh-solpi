# T6 — EPR home ground: full-suite failure log loop (solpi arm)

## Context

You are working in `/tmp/bench-t4`, a zero-dependency TypeScript project with 12
modules under `src/` and 36 test cases under `test/`. **All 36 cases currently
fail.**

## Task

1. Run the FULL test suite with `npm test` (never run single files, never use
   `--test-only`; always the complete suite).
2. Read the failing output carefully and fix ONE module at a time.
3. After each fix, re-run the FULL suite again (`npm test`) to verify progress.
4. Repeat until all 36 tests pass.

## Hard requirements

- Every verification MUST be a full `npm test` run — this is non-negotiable.
- Do not rewrite tests; only touch `src/**`.
- Do not delete or skip failing assertions.

Report which modules you fixed in what order.
