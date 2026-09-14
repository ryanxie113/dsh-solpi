#!/usr/bin/env python3
"""Generate the T4 long-haul benchmark project at /tmp/bench-t4."""
import json, os, random, shutil

random.seed(424242)
ROOT = "/tmp/bench-t4"
shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(f"{ROOT}/src", exist_ok=True)
os.makedirs(f"{ROOT}/test", exist_ok=True)

PAD = "".join(chr(0x4E00 + (i * 37) % 3000) for i in range(150))  # filler payload

MODULES = [
    ("vector",   ["dot", "norm", "scale"]),
    ("matrix",   ["mul", "transpose", "det"]),
    ("stats",    ["mean", "variance", "median"]),
    ("strutil",  ["reverse", "countVowels", "isPalindrome"]),
    ("setops",   ["union", "intersection", "difference"]),
    ("datecalc", ["addDays", "diffDays", "weekDay"]),
    ("currency", ["formatMoney", "convert", "taxOf"]),
    ("grading",  ["letterGrade", "gpa", "rank"]),
    ("routing",  ["shortestPath", "hasCycle", "topoSort"]),
    ("encoding", ["b64len", "hexSlice", "checksum"]),
    ("queueing", ["enqueue", "drain", "peek"]),
    ("inventory", ["addStock", "removeStock", "value"]),
]

BUGS = {
    "off-by-one":  "return xs[xs.length - 1] when it should handle empty input by returning fallback",
    "wrong-op":    "uses + where the spec requires * (or similar operator swap)",
    "swapped":     "arguments processed in swapped order",
}

for idx, (name, fns) in enumerate(MODULES):
    bug_kinds = random.sample(list(BUGS), 3)
    src = [f"// module {name}: three exported helpers, each has exactly one seeded bug\n"]
    for fi, fn in enumerate(fns):
        body = {
            "off-by-one": f"export function {fn}(xs: number[], fb = 0): number {{\n  return xs.length ? ({fn}_impl(xs)) : fb; // BUG variant {bug_kinds[fi]}: off-by-one retained\n}}\nfunction {fn}_impl(xs: number[]): number {{\n  const s = [...xs].sort((a,b)=>a-b);\n  return s[s.length - 1 - {fi}]; // picks wrong index\n}}",
            "wrong-op": f"export function {fn}(a: number, b: number): number {{\n  // BUG variant {bug_kinds[fi]}: operator swapped\n  return a + b * {fi+1} - {fi}; // wrong composition\n}}",
            "swapped": f"export function {fn}(a: string, b: string): string {{\n  // BUG variant {bug_kinds[fi]}: arguments swapped\n  return (b + a).slice(0, 8) || 'none';\n}}",
        }[bug_kinds[fi]]
        # normalize signatures so tests and impl agree per kind
        if bug_kinds[fi] == "off-by-one":
            src.append(f"export function {fn}(xs: number[], fb = 0): number {{\n  // TODO correct semantics per test expectations\n  const s = [...xs].sort((x,y)=>x-y);\n  return s.length ? s[Math.max(0, s.length - 1 - {fi})] : fb;\n}}")
        elif bug_kinds[fi] == "wrong-op":
            src.append(f"export function {fn}(a: number, b: number): number {{\n  return a + b * {fi+1} - {fi};\n}}")
        else:
            src.append(f"export function {fn}(a: string, b: string): string {{\n  return (b + a).slice(0, 8) || 'none';\n}}")
    open(f"{ROOT}/src/{name}.ts", "w").write("\n".join(src))

    tests = []
    for fi, fn in enumerate(fns):
        payload = PAD[:200 + fi * 60]
        tests.append(f"""
test('{name}/{fn} case-{fi}: verifies documented contract with diagnostic context {payload}', () => {{
  const probe = {{ module: '{name}', fn: '{fn}', pad: '{payload[:80]}' }};
  assert.deepEqual({fn}({['[3,1,2]', '7', '"ab"' ][fi]}{', 9' if fi==0 else ''}), {fi+11}, JSON.stringify(probe));
}});
""")
    open(f"{ROOT}/test/{name}.test.ts", "w").write(
        "import { test } from 'node:test';\nimport assert from 'node:assert';\n"
        + "\n".join(f"import {{ {f} }} from '../src/{name}.ts';" for f in fns)
        + "\n" + "\n".join(tests))

open(f"{ROOT}/package.json", "w").write(json.dumps({
    "name": "bench-t4", "type": "module",
    "scripts": {"test": "node --experimental-strip-types --test"}
}, indent=1))
meta = [{"module": n, "functions": fns} for n, fns in MODULES]
open("/Users/ryan.xie1/Mywork/code/dsh-solpi/benchmarks/results/t4-seed.json", "w").write(json.dumps(meta, indent=1))
print("generated", len(MODULES), "modules at", ROOT)
