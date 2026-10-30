// React Compiler bailout guard.
//
// The React Compiler memoizes most components automatically, so manual
// useMemo/useCallback is redundant there. But in the components it BAILS OUT
// on, the compiler memoizes nothing. Manual memoization in those functions can
// therefore be load-bearing: removing it may create unstable references that
// re-fire effects every render, causing loops that typecheck and lint miss.
//
// This runs the actual compiler over apps/web/src and every workspace package
// that ships React components (any `.tsx` source), read from the root
// manifest's `workspaces` so a new package joins on its own, and guards each
// bailed-out component or hook independently. Each baseline entry records the
// compiler's reasons, which must match the current run. A file-level baseline is not sufficient:
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
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type OxcError, transformSync } from "oxc-transform-react";

import {
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_OPTIONS,
} from "../packages/scripts/src/react-compiler-options";
import {
  type ArrowFunctionExpression,
  type Function as SyntaxFunction,
  type MethodDefinition,
  type Node,
  type ObjectProperty as Property,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { BASELINE_PATHS } from "./baseline-paths";

const BASELINE_PATH = BASELINE_PATHS.reactCompilerBailouts;
/** Cap the stale list so a large prune stays readable in CI logs. */
const STALE_PREVIEW = 10;
const MEMO_HOOK = /\buseMemo\(|\buseCallback\(/gu;
const OPT_OUT_DIRECTIVES = new Set(["use no forget", "use no memo"]);

type BailoutRecord = { reasons: Set<string>; memos: number };
type BaselineEntry = { memos: number; reasons: string[] };
type Baseline = Record<string, BaselineEntry>;

/** The web app's sources; other apps do not build through the compiler. */
const WEB_APP_ROOT = "apps/web/src";
const ROOT_MANIFEST = "package.json";
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|__tests__)\//u;

const isScannedSource = (file: string): boolean =>
  !SKIPPED_PATH.test(file) &&
  !REACT_COMPILER_EXCLUDE.some((pattern) => pattern.test(file)) &&
  !file.includes(".test.") &&
  !file.includes(".spec.") &&
  !file.endsWith(".d.ts") &&
  !file.endsWith(".gen.ts") &&
  !file.endsWith(".gen.tsx");

const sourcesUnder = (root: string): string[] =>
  [...new Bun.Glob(`${root}/**/*.{ts,tsx}`).scanSync(".")]
    .map((file) => file.replaceAll("\\", "/"))
    .filter(isScannedSource);

const workspacePatterns = (manifest: unknown): string[] => {
  const workspaces =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "workspaces")
      : undefined;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return panic(`${ROOT_MANIFEST} declares no workspaces array`);
  }
  return workspaces.filter((pattern): pattern is string => {
    if (typeof pattern !== "string") {
      return panic(`${ROOT_MANIFEST} workspaces must be strings`);
    }
    return true;
  });
};

const isReasonList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((reason) => typeof reason === "string" && reason !== "");

/** Every baseline entry carries its memo count and at least one reason. */
const parseBaseline = (raw: unknown): Baseline => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return panic(`${BASELINE_PATH} must be an object`);
  }
  const baseline: Baseline = {};
  for (const [key, value] of Object.entries(raw)) {
    const memos =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "memos")
        : undefined;
    const reasons =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "reasons")
        : undefined;
    if (!Number.isInteger(memos) || typeof memos !== "number" || memos < 0) {
      return panic(`${BASELINE_PATH} ${key}: memos must be a count`);
    }
    if (!isReasonList(reasons)) {
      return panic(`${BASELINE_PATH} ${key}: reasons must be non-empty`);
    }
    Object.defineProperty(baseline, key, {
      enumerable: true,
      value: { memos, reasons },
    });
  }
  return baseline;
};

/**
 * Workspace packages that ship React components: every manifest workspace
 * outside `apps/` with a `.tsx` source. The web app is its own root.
 */
const reactPackageRoots = (): string[] =>
  workspacePatterns(JSON.parse(readFileSync(ROOT_MANIFEST, "utf-8")))
    .flatMap((pattern) => [
      ...new Bun.Glob(`${pattern}/package.json`).scanSync("."),
    ])
    .map((manifest) => path.dirname(manifest).replaceAll("\\", "/"))
    .filter((root) => !root.startsWith("apps/"))
    .filter((root) => sourcesUnder(root).some((file) => file.endsWith(".tsx")))
    .toSorted();

type FunctionLocation = {
  end: number;
  name: string;
  start: number;
};

type FunctionNode =
  SyntaxFunction | ArrowFunctionExpression | MethodDefinition | Property;

const isFunctionLikeDeclaration = (node: Node): node is FunctionNode =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "MethodDefinition" ||
  (node.type === "Property" && (node.method || node.kind !== "init"));

const sourceFileFor = (file: string, code: string) => {
  const parsed = parseSource(file, code);
  const parents = new Map<Node, readonly Node[]>();
  walk(parsed.program, (node, ancestors) => {
    parents.set(node, [...ancestors]);
  });
  return { ...parsed, parents };
};
type SourceTree = ReturnType<typeof sourceFileFor>;

const functionName = (sourceFile: SourceTree, node: FunctionNode): string => {
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression") &&
    node.id
  ) {
    return node.id.name;
  }
  if (
    (node.type === "MethodDefinition" || node.type === "Property") &&
    node.key.type === "Identifier"
  ) {
    return node.key.name;
  }
  for (const parent of (sourceFile.parents.get(node) ?? []).toReversed()) {
    if (
      parent.type === "VariableDeclarator" &&
      parent.id.type === "Identifier"
    ) {
      return parent.id.name;
    }
  }
  const { line, column } = sourceFile.locate(node.start);
  return `<anonymous@${String(line)}:${String(column - 1)}>`;
};

const functionLocation = (
  sourceFile: SourceTree,
  node: FunctionNode,
): FunctionLocation => ({
  end: node.end,
  name: functionName(sourceFile, node),
  start: node.start,
});

const enclosingFunction = (
  sourceFile: SourceTree,
  position: number,
): FunctionNode | undefined => {
  let match: FunctionNode | undefined;
  walk(sourceFile.program, (node) => {
    if (match || position < node.start || position >= node.end) {
      return "skip-children";
    }
    if (isFunctionLikeDeclaration(node)) {
      match = node;
      return "skip-children";
    }
    return undefined;
  });
  return match;
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
  sourceFile: SourceTree,
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
  sourceFile: SourceTree,
  file: string,
  code: string,
  bailouts: Map<string, BailoutRecord>,
): void => {
  for (const directive of sourceFile.program.body) {
    if (
      directive.type !== "ExpressionStatement" ||
      directive.expression.type !== "Literal" ||
      typeof directive.expression.value !== "string"
    ) {
      break;
    }
    if (OPT_OUT_DIRECTIVES.has(directive.expression.value)) {
      addBailout(
        bailouts,
        file,
        code,
        undefined,
        `explicit module opt-out: ${directive.expression.value}`,
      );
    }
  }
  walk(sourceFile.program, (node, ancestors) => {
    if (!isFunctionLikeDeclaration(node)) {
      return;
    }
    // Methods own the function value's source range and name.
    const parent = ancestors.at(-1);
    if (
      node.type === "FunctionExpression" &&
      (parent?.type === "MethodDefinition" ||
        (parent?.type === "Property" &&
          (parent.method || parent.kind !== "init")))
    ) {
      return;
    }
    let body;
    if (node.type === "Property") {
      body = node.value.type === "FunctionExpression" ? node.value.body : null;
    } else if ("value" in node) {
      // A class method (MethodDefinition) carries its function as `value`.
      body = node.value.body;
    } else {
      body = node.body;
    }
    if (body?.type !== "BlockStatement") {
      return;
    }
    for (const directive of body.body) {
      if (
        directive.type !== "ExpressionStatement" ||
        directive.expression.type !== "Literal" ||
        typeof directive.expression.value !== "string"
      ) {
        break;
      }
      if (OPT_OUT_DIRECTIVES.has(directive.expression.value)) {
        addBailout(
          bailouts,
          file,
          code,
          functionLocation(sourceFile, node),
          `explicit opt-out: ${directive.expression.value}`,
        );
      }
    }
  });
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
        // Bailouts are recoverable diagnostics: without this the compiler
        // reports only fatal errors and every bailout goes unseen.
        reportDiagnostics: true,
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
  for (const [key, { memos, reasons }] of [...bailouts.entries()].toSorted(
    byKey,
  )) {
    current[key] = { memos, reasons: [...reasons].toSorted() };
  }
  return current;
};

type BaselineDiff = {
  added: string[];
  reasonsChanged: string[];
  regressed: string[];
  stale: string[];
};

const sameReasons = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((reason, index) => reason === right[index]);

const diffBaseline = (current: Baseline, baseline: Baseline): BaselineDiff => {
  const added: string[] = [];
  const reasonsChanged: string[] = [];
  const regressed: string[] = [];
  for (const [key, { memos, reasons }] of Object.entries(current)) {
    const previous = Object.hasOwn(baseline, key) ? baseline[key] : undefined;
    if (previous === undefined) {
      added.push(key);
      continue;
    }
    if (memos < previous.memos) {
      regressed.push(
        `${key}: ${previous.memos} -> ${memos} useMemo/useCallback`,
      );
    }
    if (!sameReasons(reasons, previous.reasons)) {
      reasonsChanged.push(key);
    }
  }
  // Baseline entries the compiler no longer bails out on. These are not
  // harmless leftovers: a stale key pre-authorizes that exact component to bail
  // out again, so the guard would stay silent on the very regression it exists
  // to catch. Treat the baseline as a ratchet that may only tighten.
  const stale = Object.keys(baseline).filter(
    (key) => !Object.hasOwn(current, key),
  );
  return { added, reasonsChanged, regressed, stale };
};

const selfTestDiff = (firstKey: string, secondKey: string) => {
  const entry = (memos: number, reason = "refs in render") => ({
    memos,
    reasons: [reason],
  });
  const diff = diffBaseline(
    {
      [firstKey]: entry(0),
      "fixture.tsx::Third": entry(1),
      "fixture.tsx::Fourth": entry(0, "try/finally"),
    },
    {
      [firstKey]: entry(1),
      [secondKey]: entry(0),
      "fixture.tsx::Fourth": entry(0),
    },
  );
  const isolationWorks =
    diff.regressed.length === 1 &&
    diff.regressed[0]?.startsWith(firstKey) === true &&
    diff.added.length === 1 &&
    diff.added[0] === "fixture.tsx::Third";
  const reasonDriftWorks =
    diff.reasonsChanged.length === 1 &&
    diff.reasonsChanged[0] === "fixture.tsx::Fourth";
  // `secondKey` is in the baseline but absent from current: exactly the stale
  // entry that used to pass unnoticed.
  const staleDetectionWorks =
    diff.stale.length === 1 && diff.stale[0] === secondKey;
  return {
    diff,
    diffWorks: isolationWorks && reasonDriftWorks && staleDetectionWorks,
  };
};

// Object literal and class methods both own their function's range, name and
// opt-out directive.
const selfTestMethodOwnership = () =>
  [
    'const view = { render() { "use no memo"; useMemo(() => 1, []); return null; } };',
    'class View { render() { "use no memo"; useMemo(() => 1, []); return null; } }',
  ].every((methodCode) => {
    const methodSource = sourceFileFor("method.tsx", methodCode);
    const methodOptOuts = new Map<string, BailoutRecord>();
    addExplicitOptOuts(methodSource, "method.tsx", methodCode, methodOptOuts);
    const methodNode = enclosingFunction(
      methodSource,
      methodCode.indexOf("useMemo"),
    );
    return (
      methodNode !== undefined &&
      functionName(methodSource, methodNode) === "render" &&
      methodOptOuts.get("method.tsx::render")?.memos === 1
    );
  });

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

  const methodOwnershipWorks = selfTestMethodOwnership();

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
  const { diff, diffWorks } = selfTestDiff(firstKey, secondKey);
  const sourceFilterWorks =
    isScannedSource("apps/web/src/components/globe.tsx") &&
    !isScannedSource("apps/web/src/hooks/use-effect.ts");
  const roots = reactPackageRoots();
  const packageScopeWorks =
    roots.includes("packages/ui") &&
    roots.includes("packages/workspace-ui") &&
    !roots.some((root) => root.startsWith("apps/"));

  if (
    identityWorks &&
    memoCountsWork &&
    byteOffsetsWork &&
    optOutWorks &&
    moduleOptOutWorks &&
    methodOwnershipWorks &&
    compilerDiagnosticWorks &&
    diffWorks &&
    packageScopeWorks &&
    sourceFilterWorks
  ) {
    console.log("rc-bailouts --self-test: PASS");
    return 0;
  }
  console.error("rc-bailouts --self-test: FAIL", {
    methodOwnershipWorks,
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
    sourceFilterWorks,
    diff,
    roots,
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
  const roots = [WEB_APP_ROOT, ...reactPackageRoots()];
  const files = roots.flatMap(sourcesUnder);
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
    for (const [key, { reasons }] of [...bailouts.entries()].toSorted(byKey)) {
      console.log(`${key}\t${[...reasons].toSorted().join(", ")}`);
    }
    console.log(
      `\nscanned ${files.length} files in ${roots.join(", ")} | bailout functions ${bailouts.size}`,
    );
    return 0;
  }

  const baseline = parseBaseline(
    JSON.parse(readFileSync(BASELINE_PATH, "utf-8")),
  );
  const { added, reasonsChanged, regressed, stale } = diffBaseline(
    current,
    baseline,
  );
  if (
    regressed.length === 0 &&
    added.length === 0 &&
    reasonsChanged.length === 0 &&
    stale.length === 0
  ) {
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
  if (reasonsChanged.length > 0) {
    console.error("\nReact Compiler bailout reasons differ from the baseline:");
    for (const key of reasonsChanged) {
      console.error(`  ${key}`);
    }
    console.error(
      "\nEach entry records why the compiler skips that function. Review the\n" +
        "new reasons, then run `bun scripts/rc-bailouts.ts --write-baseline`\n" +
        "and commit the baseline.",
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
