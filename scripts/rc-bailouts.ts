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
// Wired into .github/workflows/ci.yml, not oxlint.config: this guards every
// compiler skip, including unsupported syntax that is valid React.
import { readFileSync, writeFileSync } from "node:fs";
import { transformSync, type OxcError } from "oxc-transform-react";
import ts from "typescript";

import { REACT_COMPILER_OPTIONS } from "../apps/web/react-compiler-options.ts";
import { BASELINE_PATHS } from "./baseline-paths";

const BASELINE_PATH = BASELINE_PATHS.reactCompilerBailouts;
/** Cap the stale list so a large prune stays readable in CI logs. */
const STALE_PREVIEW = 10;
const MEMO_HOOK = /\buseMemo\(|\buseCallback\(/gu;
const OPT_OUT_DIRECTIVES = new Set(["use no forget", "use no memo"]);

type BailoutRecord = { reasons: Set<string>; memos: number };
type Baseline = Record<string, number>;

type FunctionLocation = {
  end: number;
  name: string;
  start: number;
};

const isFunctionLikeDeclaration = (
  node: ts.Node,
): node is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const scriptKind = (file: string): ts.ScriptKind =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const sourceFileFor = (file: string, code: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );

const functionName = (
  sourceFile: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
): string => {
  if (node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  let current: ts.Node = node;
  while (!ts.isSourceFile(current.parent)) {
    const { parent } = current;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    current = parent;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `<anonymous@${String(line + 1)}:${String(character)}>`;
};

const functionLocation = (
  sourceFile: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
): FunctionLocation => ({
  end: node.getEnd(),
  name: functionName(sourceFile, node),
  start: node.getStart(sourceFile),
});

const enclosingFunction = (
  sourceFile: ts.SourceFile,
  position: number,
): ts.FunctionLikeDeclaration | undefined => {
  const find = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    if (position < node.getFullStart() || position >= node.getEnd()) {
      return undefined;
    }
    if (isFunctionLikeDeclaration(node)) {
      return node;
    }

    let match: ts.FunctionLikeDeclaration | undefined;
    node.forEachChild((child) => {
      match ??= find(child);
    });
    return match;
  };

  return find(sourceFile);
};

// Oxc reports UTF-8 byte offsets while TypeScript's AST uses UTF-16 code-unit
// offsets. Convert at the boundary so a non-ASCII prefix cannot attribute a
// bailout to the wrong function.
const codeUnitIndex = (code: string, byteOffset: number): number =>
  Buffer.from(code).subarray(0, byteOffset).toString("utf-8").length;

const countMemos = (code: string, location: FunctionLocation): number =>
  (code.slice(location.start, location.end).match(MEMO_HOOK) ?? []).length;

const addBailout = (
  bailouts: Map<string, BailoutRecord>,
  file: string,
  code: string,
  location: FunctionLocation | undefined,
  reason: string,
): void => {
  const key = `${file}::${location?.name ?? "<module-transform>"}`;
  const record = bailouts.get(key) ?? {
    reasons: new Set<string>(),
    memos:
      location === undefined
        ? (code.match(MEMO_HOOK) ?? []).length
        : countMemos(code, location),
  };
  record.reasons.add(reason);
  bailouts.set(key, record);
};

const diagnosticLocation = (
  sourceFile: ts.SourceFile,
  code: string,
  error: OxcError,
): FunctionLocation | undefined => {
  const label = error.labels.at(0);
  if (label === undefined) {
    return undefined;
  }
  const node = enclosingFunction(sourceFile, codeUnitIndex(code, label.start));
  return node === undefined ? undefined : functionLocation(sourceFile, node);
};

const addExplicitOptOuts = (
  sourceFile: ts.SourceFile,
  file: string,
  code: string,
  bailouts: Map<string, BailoutRecord>,
): void => {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      break;
    }
    if (OPT_OUT_DIRECTIVES.has(statement.expression.text)) {
      addBailout(
        bailouts,
        file,
        code,
        undefined,
        `explicit module opt-out: ${statement.expression.text}`,
      );
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      isFunctionLikeDeclaration(node) &&
      node.body !== undefined &&
      ts.isBlock(node.body)
    ) {
      for (const statement of node.body.statements) {
        if (
          !ts.isExpressionStatement(statement) ||
          !ts.isStringLiteral(statement.expression)
        ) {
          break;
        }
        if (OPT_OUT_DIRECTIVES.has(statement.expression.text)) {
          addBailout(
            bailouts,
            file,
            code,
            functionLocation(sourceFile, node),
            `explicit opt-out: ${statement.expression.text}`,
          );
        }
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
};

const scanFile = (
  file: string,
  code: string,
  bailouts: Map<string, BailoutRecord>,
): void => {
  const sourceFile = sourceFileFor(file, code);
  addExplicitOptOuts(sourceFile, file, code, bailouts);

  try {
    const result = transformSync(file, code, {
      lang: file.endsWith(".tsx") ? "tsx" : "ts",
      jsx: "preserve",
      reactCompiler: {
        ...REACT_COMPILER_OPTIONS,
        outputMode: "lint",
      },
    });
    for (const error of result.errors) {
      addBailout(
        bailouts,
        file,
        code,
        diagnosticLocation(sourceFile, code, error),
        error.message,
      );
    }
    if (result.fatal) {
      addBailout(bailouts, file, code, undefined, "fatal transform");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "throw";
    addBailout(
      bailouts,
      file,
      code,
      undefined,
      `transform-threw: ${message.slice(0, 60)}`,
    );
  }
};

// Code-unit order on the key. `Array#sort` with no comparator orders entries by
// their string form, which for a `[key, record]` tuple is
// `` `${key},[object Object]` `` — so the serialized baseline's ordering would
// depend on how a record happens to stringify. Keys are Map keys, hence unique.
const byKey = (
  [left]: readonly [string, BailoutRecord],
  [right]: readonly [string, BailoutRecord],
): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const toBaseline = (bailouts: Map<string, BailoutRecord>): Baseline => {
  const current: Baseline = {};
  for (const [key, { memos }] of [...bailouts.entries()].sort(byKey)) {
    current[key] = memos;
  }
  return current;
};

type BaselineDiff = {
  added: string[];
  regressed: string[];
  stale: string[];
};

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
  // Baseline entries the compiler no longer bails out on. These are not
  // harmless leftovers: a stale key pre-authorizes that exact component to bail
  // out again, so the guard would stay silent on the very regression it exists
  // to catch. Treat the baseline as a ratchet that may only tighten.
  const stale = Object.keys(baseline).filter((key) => !(key in current));
  return { added, regressed, stale };
};

const runSelfTest = (): number => {
  const code = [
    "export const Outer = () => {",
    '  const unicodePrefix = "😀";',
    "  const Inner = () => ref.current;",
    "  useMemo(() => 1, []);",
    "  return Inner();",
    "};",
    "export function Second() {",
    "  useCallback(() => {}, []);",
    "}",
  ].join("\n");
  const sourceFile = sourceFileFor("fixture.tsx", code);
  const refCodeUnitIndex = code.indexOf("ref.current");
  const refByteOffset = Buffer.byteLength(code.slice(0, refCodeUnitIndex));
  const outerNode = enclosingFunction(
    sourceFile,
    codeUnitIndex(code, refByteOffset),
  );
  const secondNode = enclosingFunction(sourceFile, code.indexOf("useCallback"));
  const outerLocation =
    outerNode === undefined
      ? undefined
      : functionLocation(sourceFile, outerNode);
  const secondLocation =
    secondNode === undefined
      ? undefined
      : functionLocation(sourceFile, secondNode);
  const firstKey = `fixture.tsx::${outerLocation?.name ?? "missing"}`;
  const secondKey = `fixture.tsx::${secondLocation?.name ?? "missing"}`;
  const identityWorks =
    firstKey === "fixture.tsx::Outer" && secondKey === "fixture.tsx::Second";
  const memoCountsWork =
    outerLocation !== undefined &&
    secondLocation !== undefined &&
    countMemos(code, outerLocation) === 1 &&
    countMemos(code, secondLocation) === 1;
  const byteOffsetsWork =
    refByteOffset > refCodeUnitIndex &&
    codeUnitIndex(code, refByteOffset) === refCodeUnitIndex;

  const optOutCode = [
    "export const Skipped = () => {",
    '  "use no memo";',
    "  useMemo(() => 1, []);",
    "  return null;",
    "};",
  ].join("\n");
  const optOuts = new Map<string, BailoutRecord>();
  scanFile("opt-out.tsx", optOutCode, optOuts);
  const optOut = optOuts.get("opt-out.tsx::Skipped");
  const optOutWorks =
    optOut?.memos === 1 && optOut.reasons.has("explicit opt-out: use no memo");

  const moduleOptOutCode = [
    '"use no forget";',
    "export function ModuleSkipped() {",
    "  return null;",
    "}",
  ].join("\n");
  const moduleOptOuts = new Map<string, BailoutRecord>();
  scanFile("module-opt-out.tsx", moduleOptOutCode, moduleOptOuts);
  const moduleOptOutWorks = moduleOptOuts
    .get("module-opt-out.tsx::<module-transform>")
    ?.reasons.has("explicit module opt-out: use no forget");

  const compilerCode = [
    "export function RefReader() {",
    "  const ref = useRef(null);",
    "  return ref.current;",
    "}",
  ].join("\n");
  const compilerBailouts = new Map<string, BailoutRecord>();
  scanFile("compiler.tsx", compilerCode, compilerBailouts);
  const compilerDiagnosticWorks = compilerBailouts.has(
    "compiler.tsx::RefReader",
  );
  const diff = diffBaseline(
    { [firstKey]: 0, "fixture.tsx::Third": 1 },
    { [firstKey]: 1, [secondKey]: 0 },
  );
  const isolationWorks =
    diff.regressed.length === 1 &&
    diff.regressed[0]?.startsWith(firstKey) === true &&
    diff.added.length === 1 &&
    diff.added[0] === "fixture.tsx::Third";
  // `secondKey` is in the baseline but absent from current: exactly the stale
  // entry that used to pass unnoticed.
  const staleDetectionWorks =
    diff.stale.length === 1 && diff.stale[0] === secondKey;

  if (
    identityWorks &&
    memoCountsWork &&
    byteOffsetsWork &&
    optOutWorks &&
    moduleOptOutWorks &&
    compilerDiagnosticWorks &&
    isolationWorks &&
    staleDetectionWorks
  ) {
    console.log("rc-bailouts --self-test: PASS");
    return 0;
  }
  console.error("rc-bailouts --self-test: FAIL", {
    firstKey,
    secondKey,
    firstMemos:
      outerLocation === undefined ? undefined : countMemos(code, outerLocation),
    secondMemos:
      secondLocation === undefined
        ? undefined
        : countMemos(code, secondLocation),
    byteOffsetsWork,
    optOutWorks,
    moduleOptOutWorks,
    compilerDiagnosticWorks,
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
    for (const [key, { reasons }] of [...bailouts.entries()].sort(byKey)) {
      console.log(`${key}\t${[...reasons].sort().join(", ")}`);
    }
    console.log(
      `\nscanned ${files.length} files | bailout functions ${bailouts.size}`,
    );
    return 0;
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  const { added, regressed, stale } = diffBaseline(current, baseline);
  if (regressed.length === 0 && added.length === 0 && stale.length === 0) {
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
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer bail out:`,
    );
    for (const key of stale.slice(0, STALE_PREVIEW)) {
      console.error(`  ${key}`);
    }
    if (stale.length > STALE_PREVIEW) {
      console.error(`  ... and ${stale.length - STALE_PREVIEW} more`);
    }
    console.error(
      "\nThe compiler now optimizes these, so the baseline must be pruned: while\n" +
        "a stale entry remains, that component may silently start bailing out\n" +
        "again without this guard noticing. Run `bun scripts/rc-bailouts.ts\n" +
        "--write-baseline` and commit the baseline.",
    );
  }
  return 1;
};

process.exit(run());
