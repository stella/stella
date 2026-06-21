// React Compiler bailout guard.
//
// The React Compiler memoizes most components automatically, so manual
// useMemo/useCallback is redundant there. But in the components it BAILS OUT
// on (cannot access refs during render, try/finally, an ESLint suppression on
// the component, etc.) the compiler memoizes nothing — so manual memoization
// is load-bearing. Removing it leaves unstable references that re-fire effects
// every render: infinite "Maximum update depth exceeded" loops that typecheck
// and lint do NOT catch.
//
// This runs the actual compiler (no native/Rust equivalent exists yet — see
// oxc-project/oxc#15258) over apps/web/src and guards a baseline so that:
//   * a bailout file losing memoization fails CI (the regression), and
//   * a brand-new bailout component must be acknowledged in the baseline.
//
// Modes:
//   bun scripts/rc-bailouts.ts                 report bailouts + reasons
//   bun scripts/rc-bailouts.ts --write-baseline regenerate the baseline
//   bun scripts/rc-bailouts.ts --check          CI gate (exit 1 on regression)
//
// CI-only by design: it runs the JS compiler, so it is too slow for the local
// lint/pre-commit loop. Wired into .github/workflows/ci.yml, not oxlint.config.
import { transformSync } from "@babel/core";
import { readFileSync, writeFileSync } from "node:fs";

const reactCompiler =
  require("babel-plugin-react-compiler").default ??
  require("babel-plugin-react-compiler");

const BASELINE_PATH = "scripts/react-compiler-bailouts.json";
const mode = process.argv.includes("--write-baseline")
  ? "write"
  : process.argv.includes("--check")
    ? "check"
    : "report";

const files = [
  ...new Bun.Glob("apps/web/src/**/*.{ts,tsx}").scanSync("."),
].filter(
  (f) =>
    !f.includes("/__tests__/") &&
    !f.includes(".test.") &&
    !f.includes(".spec.") &&
    !f.endsWith(".gen.ts") &&
    !f.endsWith(".gen.tsx"),
);

const countMemos = (code: string) =>
  (code.match(/\buseMemo\(|\buseCallback\(/g) ?? []).length;

const bailouts = new Map<string, { reasons: Set<string>; memos: number }>();

for (const file of files) {
  const code = readFileSync(file, "utf8");
  const reasons = new Set<string>();
  const logger = {
    logEvent(_f: string, event: any) {
      const kind = event?.kind;
      if (
        kind === "CompileError" ||
        kind === "CompileSkip" ||
        kind === "PipelineError"
      ) {
        const opts = event?.detail?.options ?? event?.detail ?? {};
        reasons.add(String(opts.category ?? kind));
      }
    },
  };
  try {
    transformSync(code, {
      filename: file,
      babelrc: false,
      configFile: false,
      code: false,
      ast: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [[reactCompiler, { panicThreshold: "none", logger }]],
    });
  } catch (e: any) {
    reasons.add(
      `transform-threw: ${String(e?.message ?? "throw").slice(0, 60)}`,
    );
  }
  if (reasons.size > 0) {
    bailouts.set(file, { reasons, memos: countMemos(code) });
  }
}

const current: Record<string, number> = {};
for (const [file, { memos }] of [...bailouts.entries()].sort()) {
  current[file] = memos;
}

if (mode === "write") {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(current).length} bailout files to ${BASELINE_PATH}`,
  );
  process.exit(0);
}

if (mode === "report") {
  for (const [file, { reasons }] of [...bailouts.entries()].sort()) {
    console.log(`${file}\t${[...reasons].join(", ")}`);
  }
  console.log(`\nscanned ${files.length} | bailout files ${bailouts.size}`);
  process.exit(0);
}

// --check
const baseline: Record<string, number> = JSON.parse(
  readFileSync(BASELINE_PATH, "utf8"),
);
const regressed: string[] = [];
const added: string[] = [];

for (const [file, memos] of Object.entries(current)) {
  if (!(file in baseline)) {
    added.push(file);
  } else if (memos < baseline[file]) {
    regressed.push(
      `${file}: ${baseline[file]} -> ${memos} useMemo/useCallback`,
    );
  }
}

if (regressed.length === 0 && added.length === 0) {
  console.log(
    `OK: ${Object.keys(current).length} React Compiler bailout files, memoization intact.`,
  );
  process.exit(0);
}

if (regressed.length > 0) {
  console.error(
    "\nMemoization removed from React Compiler bailout component(s):",
  );
  for (const r of regressed) {
    console.error(`  ${r}`);
  }
  console.error(
    "\nThese components are NOT optimized by the compiler, so manual memoization\n" +
      "is load-bearing — removing it can cause render loops. Restore the memo, or,\n" +
      "if you have verified the removal is safe, run `bun scripts/rc-bailouts.ts\n" +
      "--write-baseline` and commit the updated baseline.",
  );
}
if (added.length > 0) {
  console.error(
    "\nNew React Compiler bailout component(s) not in the baseline:",
  );
  for (const a of added) {
    console.error(`  ${a}`);
  }
  console.error(
    "\nThese components opted out of compiler optimization. Keep their manual\n" +
      "memoization, then run `bun scripts/rc-bailouts.ts --write-baseline` and\n" +
      "commit the baseline so future removals are guarded.",
  );
}
process.exit(1);
