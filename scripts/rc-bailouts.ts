// React Compiler bailout guard.
//
// The React Compiler memoizes most components automatically, so manual
// useMemo/useCallback is redundant there. But in the components it BAILS OUT
// on, the compiler memoizes nothing. Manual memoization in those functions can
// therefore be load-bearing: removing it may create unstable references that
// re-fire effects every render, causing loops that typecheck and lint miss.
//
// This runs the actual compiler over apps/web/src and guards each bailed-out
// component or hook independently. A file-level baseline is not sufficient:
// a new bailout in an already-listed file or a memo added to one component
// could otherwise hide a regression in another component.
//
// Modes:
//   bun scripts/rc-bailouts.ts                  report bailouts + reasons
//   bun scripts/rc-bailouts.ts --write-baseline regenerate the baseline
//   bun scripts/rc-bailouts.ts --check          CI gate (exit 1 on regression)
//   bun scripts/rc-bailouts.ts --self-test      prove component attribution
//
// CI-only by design: it runs the JS compiler, so it is too slow for the local
// lint/pre-commit loop. Wired into .github/workflows/ci.yml, not oxlint.config.
import { transformSync } from "@babel/core";
import reactCompiler, { type LoggerEvent } from "babel-plugin-react-compiler";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE_PATH = "scripts/react-compiler-bailouts.json";
const MEMO_HOOK = /\buseMemo\(|\buseCallback\(/gu;
const FUNCTION_DECLARATION =
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\b/u;
const ASSIGNED_FUNCTION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/u;

type SourcePosition = {
  readonly line: number;
  readonly column: number;
  readonly index?: number;
};

type SourceLocation = {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
};

type BailoutRecord = { reasons: Set<string>; memos: number };
type Baseline = Record<string, number>;
type BailoutEvent = Extract<
  LoggerEvent,
  { kind: "CompileError" | "CompileSkip" | "PipelineError" }
>;

const sourceIndex = (code: string, position: SourcePosition): number => {
  if (position.index !== undefined) {
    return position.index;
  }
  const lines = code.split("\n");
  let index = 0;
  for (let line = 1; line < position.line; line += 1) {
    index += (lines[line - 1]?.length ?? 0) + 1;
  }
  return index + position.column;
};

const functionName = (code: string, location: SourceLocation): string => {
  const start = sourceIndex(code, location.start);
  const end = sourceIndex(code, location.end);
  const source = code.slice(start, end);
  const declarationName = source.match(FUNCTION_DECLARATION)?.[1];
  if (declarationName !== undefined) {
    return declarationName;
  }

  const lineStart = code.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const leftOfFunction = code.slice(lineStart, start);
  const assignedName = leftOfFunction.match(ASSIGNED_FUNCTION)?.[1];
  if (assignedName !== undefined) {
    return assignedName;
  }

  return `<anonymous@${location.start.line}:${location.start.column}>`;
};

const bailoutKey = (
  file: string,
  code: string,
  location: SourceLocation,
): string => `${file}::${functionName(code, location)}`;

const countMemos = (code: string, location: SourceLocation): number => {
  const start = sourceIndex(code, location.start);
  const end = sourceIndex(code, location.end);
  return (code.slice(start, end).match(MEMO_HOOK) ?? []).length;
};

const bailoutReason = (event: BailoutEvent): string => {
  if (event.kind === "CompileSkip") {
    return event.reason;
  }
  if (event.kind === "PipelineError") {
    return event.data;
  }
  return String(event.detail.category);
};

const isBailoutEvent = (event: LoggerEvent): event is BailoutEvent =>
  event.kind === "CompileError" ||
  event.kind === "CompileSkip" ||
  event.kind === "PipelineError";

const scanFile = (
  file: string,
  code: string,
  bailouts: Map<string, BailoutRecord>,
): void => {
  const logger = {
    logEvent(_file: string | null, event: LoggerEvent) {
      if (!isBailoutEvent(event)) {
        return;
      }
      const location = event.fnLoc;
      if (location === null) {
        const key = `${file}::<module-transform>`;
        const record = bailouts.get(key) ?? {
          reasons: new Set<string>(),
          memos: (code.match(MEMO_HOOK) ?? []).length,
        };
        record.reasons.add(bailoutReason(event));
        bailouts.set(key, record);
        return;
      }

      const key = bailoutKey(file, code, location);
      const record = bailouts.get(key) ?? {
        reasons: new Set<string>(),
        memos: countMemos(code, location),
      };
      record.reasons.add(bailoutReason(event));
      bailouts.set(key, record);
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
  } catch (error: unknown) {
    const key = `${file}::<module-transform>`;
    const message = error instanceof Error ? error.message : "throw";
    bailouts.set(key, {
      reasons: new Set([`transform-threw: ${message.slice(0, 60)}`]),
      memos: (code.match(MEMO_HOOK) ?? []).length,
    });
  }
};

const toBaseline = (bailouts: Map<string, BailoutRecord>): Baseline => {
  const current: Baseline = {};
  for (const [key, { memos }] of [...bailouts.entries()].sort()) {
    current[key] = memos;
  }
  return current;
};

type BaselineDiff = { added: string[]; regressed: string[] };

const diffBaseline = (current: Baseline, baseline: Baseline): BaselineDiff => {
  const added: string[] = [];
  const regressed: string[] = [];
  for (const [key, memos] of Object.entries(current)) {
    if (!(key in baseline)) {
      added.push(key);
      continue;
    }
    const previous = baseline[key];
    if (previous !== undefined && memos < previous) {
      regressed.push(`${key}: ${previous} -> ${memos} useMemo/useCallback`);
    }
  }
  return { added, regressed };
};

const runSelfTest = (): number => {
  const code = [
    "export const First = () => {",
    "  useMemo(() => 1, []);",
    "};",
    "export function Second() {",
    "  useCallback(() => {}, []);",
    "}",
  ].join("\n");
  const firstStart = code.indexOf("() =>");
  const firstEnd = code.indexOf("};") + 1;
  const secondStart = code.indexOf("function Second");
  const secondEnd = code.length;
  const firstLocation: SourceLocation = {
    start: { line: 1, column: firstStart, index: firstStart },
    end: { line: 3, column: 1, index: firstEnd },
  };
  const secondLocation: SourceLocation = {
    start: { line: 4, column: 7, index: secondStart },
    end: { line: 6, column: 1, index: secondEnd },
  };

  const firstKey = bailoutKey("fixture.tsx", code, firstLocation);
  const secondKey = bailoutKey("fixture.tsx", code, secondLocation);
  const identityWorks =
    firstKey === "fixture.tsx::First" && secondKey === "fixture.tsx::Second";
  const memoCountsWork =
    countMemos(code, firstLocation) === 1 &&
    countMemos(code, secondLocation) === 1;
  const diff = diffBaseline(
    { [firstKey]: 0, "fixture.tsx::Third": 1 },
    { [firstKey]: 1, [secondKey]: 0 },
  );
  const isolationWorks =
    diff.regressed.length === 1 &&
    diff.regressed[0]?.startsWith(firstKey) === true &&
    diff.added.length === 1 &&
    diff.added[0] === "fixture.tsx::Third";

  if (identityWorks && memoCountsWork && isolationWorks) {
    console.log("rc-bailouts --self-test: PASS");
    return 0;
  }
  console.error("rc-bailouts --self-test: FAIL", {
    firstKey,
    secondKey,
    firstMemos: countMemos(code, firstLocation),
    secondMemos: countMemos(code, secondLocation),
    diff,
  });
  return 1;
};

const run = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }

  let mode = "report";
  if (process.argv.includes("--write-baseline")) {
    mode = "write";
  } else if (process.argv.includes("--check")) {
    mode = "check";
  }
  const files = [
    ...new Bun.Glob("apps/web/src/**/*.{ts,tsx}").scanSync("."),
  ].filter(
    (file) =>
      !file.includes("/__tests__/") &&
      !file.includes(".test.") &&
      !file.includes(".spec.") &&
      !file.endsWith(".gen.ts") &&
      !file.endsWith(".gen.tsx"),
  );
  const bailouts = new Map<string, BailoutRecord>();
  for (const file of files) {
    scanFile(file, readFileSync(file, "utf-8"), bailouts);
  }
  const current = toBaseline(bailouts);

  if (mode === "write") {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
      `Wrote ${Object.keys(current).length} bailout functions to ${BASELINE_PATH}`,
    );
    return 0;
  }

  if (mode === "report") {
    for (const [key, { reasons }] of [...bailouts.entries()].sort()) {
      console.log(`${key}\t${[...reasons].sort().join(", ")}`);
    }
    console.log(
      `\nscanned ${files.length} files | bailout functions ${bailouts.size}`,
    );
    return 0;
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  const { added, regressed } = diffBaseline(current, baseline);
  if (regressed.length === 0 && added.length === 0) {
    console.log(
      `OK: ${Object.keys(current).length} React Compiler bailout functions, memoization intact.`,
    );
    return 0;
  }

  if (regressed.length > 0) {
    console.error(
      "\nMemoization removed from React Compiler bailout component(s):",
    );
    for (const regression of regressed) {
      console.error(`  ${regression}`);
    }
    console.error(
      "\nThese functions are NOT optimized by the compiler, so manual memoization\n" +
        "is load-bearing. Restore the memo, or, after verifying the removal is\n" +
        "safe, regenerate and commit the baseline.",
    );
  }
  if (added.length > 0) {
    console.error(
      "\nNew React Compiler bailout component(s) not in the baseline:",
    );
    for (const key of added) {
      console.error(`  ${key}`);
    }
    console.error(
      "\nThese functions opted out of compiler optimization. Keep any required\n" +
        "manual memoization, then run `bun scripts/rc-bailouts.ts\n" +
        "--write-baseline` and commit the baseline.",
    );
  }
  return 1;
};

process.exit(run());
