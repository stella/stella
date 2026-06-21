// Run the React Compiler over apps/web/src and report which functions it
// BAILS on. Where the compiler bails, manual useMemo/useCallback is
// load-bearing (the compiler won't memoize, so removing memos can destabilize
// refs and cause render loops). Throwaway diagnostic; safe to delete.
import { transformSync } from "@babel/core";
import { readFileSync } from "node:fs";

const reactCompiler =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("babel-plugin-react-compiler").default ??
  require("babel-plugin-react-compiler");

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

const bailouts = new Map<string, { fn: string; reason: string }[]>();
let totalOk = 0;

for (const file of files) {
  const code = readFileSync(file, "utf8");
  const fileBailouts: { fn: string; reason: string }[] = [];
  const logger = {
    logEvent(_f: string, event: any) {
      const kind = event?.kind;
      if (kind === "CompileSuccess") {
        totalOk++;
        return;
      }
      if (
        kind === "CompileError" ||
        kind === "CompileSkip" ||
        kind === "PipelineError"
      ) {
        const opts = event?.detail?.options ?? event?.detail ?? {};
        const reason = `${opts.category ?? kind}: ${opts.reason ?? ""}`;
        fileBailouts.push({ fn: opts.category ?? kind, reason: reason.slice(0, 100) });
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
    fileBailouts.push({
      fn: "<transform-threw>",
      reason: String(e?.message ?? "throw").slice(0, 90),
    });
  }
  if (fileBailouts.length > 0) {
    bailouts.set(file, fileBailouts);
  }
}

// Files the memo cleanup actually modified (commit 76012294d).
const memoTouched = new Set(
  Bun.spawnSync([
    "git",
    "show",
    "--name-only",
    "--format=",
    "76012294d",
  ])
    .stdout.toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Reason histogram.
const reasons = new Map<string, number>();
for (const bs of bailouts.values()) {
  for (const b of bs) {
    reasons.set(b.reason, (reasons.get(b.reason) ?? 0) + 1);
  }
}

const risk = [...bailouts.keys()].filter((f) => memoTouched.has(f)).sort();
console.log("=== RISK SET: compiler bails AND memo cleanup touched it ===");
for (const f of risk) {
  console.log(`  ${f}`);
}
console.log("\n=== bailout reason histogram ===");
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}\t${r}`);
}
console.log(
  `\nscanned ${files.length} | bailout files ${bailouts.size} | OK fns ${totalOk} | RISK (bailout ∩ memo-touched): ${risk.length}`,
);
