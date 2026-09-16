# T6b — forced echo diagnostic loop (solpi arm)

## Context

You are working in `/tmp/bench-t4`, a zero-dependency TypeScript project with 12
modules under `src/` and 36 test cases under `test/`. All cases currently fail.

## Task

Fix all modules until the full suite passes.

## Hard requirements (compliance is graded)

- Every verification MUST be `npm test` run DIRECTLY in the terminal — its FULL
  output must appear in your tool result. Do NOT redirect to a file.
- You MUST NOT pipe npm test through grep/head/tail/less or any filter.
- You MUST NOT save output to any file for later reading.
- Read failing details from the full terminal output only.
