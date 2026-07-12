// Convention ratchet guard.
//
// A ratchet is a set of whole-repo metrics that may only ever DECREASE: each
// metric's current count is compared to a committed baseline, a rise fails CI
// (a new violation of a convention), and a fall just prompts you to run
// `--write` to lock in the improvement so it can never regress. This
// generalizes the ad hoc per-guard baselines (React Compiler bailouts, MCP
// pending) into one declarative table of dumb, deterministic, line-based
// counters — no AST, no oxlint, fast enough to keep the local loop honest.
//
// To add a metric: append an entry to RATCHET_METRICS with a stable `id`, a
// human `description`, the `include` globs (repo-relative), an `exclude`
// predicate, and a `count(content)` per-file counter (a lexical/regex scan;
// keep it deterministic and cheap). Then run `bun scripts/ratchet.ts --write`
// to seed its baseline, and commit both files. The counter must count exactly
// what its description claims — the `--self-test` fixtures enforce that.
//
// Modes:
//   bun scripts/ratchet.ts            report current counts vs baseline
//   bun scripts/ratchet.ts --check    CI gate (exit 1 only when a count rose)
//   bun scripts/ratchet.ts --write    regenerate the baseline
//   bun scripts/ratchet.ts --self-test prove each counter counts what it claims
//
// CI-only wiring lives in .github/workflows/ci.yml and scripts/verify.sh
// alongside the other ratchet guards.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(SCRIPTS_DIR, "ratchet-baseline.json");
const BASELINE_REL = "scripts/ratchet-baseline.json";
const WRITE_HINT = "bun scripts/ratchet.ts --write";

// Shared source globs + exclusions for the app-source metrics.
const APP_SOURCE_GLOBS = [
  "apps/api/src/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
] as const;

const isExcludedSource = (file: string): boolean =>
  file.endsWith(".d.ts") ||
  /\.gen\./u.test(file) ||
  /\.test\./u.test(file) ||
  /\.spec\./u.test(file) ||
  file.includes("/tests/") ||
  file.includes("/e2e/") ||
  file.includes("/__tests__/");

// --- Counters ---------------------------------------------------------------
// All counters take raw file text and return a per-file occurrence count. They
// are line-oriented so cheap comment/import filtering can drop obvious noise.

// Lines that are pure comments (JSDoc `*`, `//`, `/* ... */` openers).
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u;
const LINE_COMMENT_TAIL = /\/\/.*$/u;
// `as unknown as T` is one assertion, not two: collapse it before counting.
const AS_UNKNOWN_AS = /\bas\s+unknown\s+as\b/gu;
// A type assertion: ` as ` not immediately followed by `const`.
const AS_CAST = /\bas\s+(?!const\b)/gu;
const AS_UNKNOWN_PLACEHOLDER = "as  ";
const MAPPED_TYPE_REMAP_PLACEHOLDER = "remap ";
// Mapped types use `as` to remap keys (`[K in keyof T as F<K>]`). This is
// type-level syntax, not a value assertion. The `in` before `as` distinguishes
// it from computed array/index expressions that may contain a real assertion.
const MAPPED_TYPE_KEY_REMAP = /(?<mappedPrefix>\[[^\]]*\bin\b[^\]]*)\bas\s+/gu;

// Module syntax carries alias `as` (`import { x as y }`, `import * as ns`,
// `export { x as y }`, `export * as ns`) that is NOT a type assertion. These
// statements can span multiple lines, so exclude the whole statement, not just
// the opening line.
const MODULE_STMT_OPEN =
  /^\s*(?:import\b|export\s+(?:type\s+)?\{|export\s+\*)/u;
const MODULE_STMT_TERMINATOR = /\bfrom\b|\};?\s*$|;\s*$/u;

// --- String/template literal stripping --------------------------------------
// A regex counter scanning raw line text cannot tell "as" the type-assertion
// keyword from "as" the English word sitting inside a string, and a stray `//`
// inside a string (e.g. a URL) must not be mistaken for a comment tail. Every
// counter below first blanks string/template literal contents so it only ever
// scans code, keeping with the file's "dumb, deterministic, line-based — no
// AST" design: this is still a single char-by-char pass per line, carrying
// only the minimal state needed to survive a template literal that spans
// multiple lines.
//
// Trade-off: `${...}` interpolation inside a template literal is NOT parsed
// specially — the whole template span up to the next unescaped backtick is
// blanked, interpolation included. A cast written inside an interpolation
// (`` `${x as T}` ``) is therefore missed, and a backtick nested inside an
// interpolation (`` `${`nested`}` ``) is not handled correctly. Both are rare
// in practice; a lexer that tracks interpolation nesting (itself possibly
// containing new strings/templates) would no longer be "cheap" or
// "line-based". Accepted, documented fidelity limit — same spirit as the
// other known limitations called out in the self-test fixtures below.
const BLANKED_LITERAL = " ";

type LiteralScanState = { readonly inTemplate: boolean };

const NO_OPEN_TEMPLATE: LiteralScanState = { inTemplate: false };

// Index of the next unescaped `quote` at or after `from`, or -1.
const findUnescapedQuote = (
  line: string,
  from: number,
  quote: string,
): number => {
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1; // skip the escaped character, whatever it is
      continue;
    }
    if (ch === quote) {
      return i;
    }
  }
  return -1;
};

// Blank string/template literal contents in `raw`, carrying open-template
// state across lines. Returns the remaining code (literal contents replaced
// by a single space, so word boundaries around the literal still hold) plus
// the state to pass into the next line.
const stripStringLiterals = (
  raw: string,
  state: LiteralScanState,
): { code: string; state: LiteralScanState } => {
  let out = "";
  let i = 0;

  if (state.inTemplate) {
    const close = findUnescapedQuote(raw, 0, "`");
    if (close === -1) {
      return { code: out, state };
    }
    out += BLANKED_LITERAL;
    i = close + 1;
  }

  let inTemplate = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = findUnescapedQuote(raw, i + 1, ch);
      if (close === -1) {
        // Unterminated: a template literal legitimately continues on the
        // next line; an unterminated '/" is invalid JS, blank defensively.
        if (ch === "`") {
          inTemplate = true;
        }
        break;
      }
      out += BLANKED_LITERAL;
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { code: out, state: { inTemplate } };
};

// Blank literals, then drop the trailing `//` comment. Order matters: doing
// this on the ORIGINAL line (as the counters used to) means a `//` inside a
// string (e.g. `const s = "http://x" as string;`) truncates the line before
// the string is ever recognized as a string, silently dropping real code
// (including real casts) after it. Stripping literals first fixes that.
const stripLine = (
  raw: string,
  state: LiteralScanState,
): { code: string; state: LiteralScanState } => {
  const { code, state: nextState } = stripStringLiterals(raw, state);
  return { code: code.replace(LINE_COMMENT_TAIL, ""), state: nextState };
};

const stripBlockComments = (
  code: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } => {
  let output = "";
  let cursor = 0;
  let inside = inBlockComment;
  while (cursor < code.length) {
    if (inside) {
      const close = code.indexOf("*/", cursor);
      if (close === -1) {
        return { code: output, inBlockComment: true };
      }
      cursor = close + 2;
      inside = false;
      continue;
    }
    const open = code.indexOf("/*", cursor);
    if (open === -1) {
      output += code.slice(cursor);
      break;
    }
    output += code.slice(cursor, open);
    cursor = open + 2;
    inside = true;
  }
  return { code: output, inBlockComment: inside };
};

const countAsCasts = (content: string): number => {
  let total = 0;
  let inModuleStmt = false;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;

    if (inModuleStmt) {
      if (MODULE_STMT_TERMINATOR.test(code)) {
        inModuleStmt = false;
      }
      continue;
    }
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    if (MODULE_STMT_OPEN.test(code)) {
      if (!MODULE_STMT_TERMINATOR.test(code)) {
        inModuleStmt = true;
      }
      continue;
    }
    const scanned = code
      .replace(AS_UNKNOWN_AS, AS_UNKNOWN_PLACEHOLDER)
      .replace(
        MAPPED_TYPE_KEY_REMAP,
        `$<mappedPrefix>${MAPPED_TYPE_REMAP_PLACEHOLDER}`,
      );
    total += (scanned.match(AS_CAST) ?? []).length;
  }
  return total;
};

const NULLISH_ARRAY = /\?\?\s*\[\]/gu;

// Same false-positive class as as-casts (a string/template can contain
// literal `?? []` text, e.g. an error message or doc example) and shares the
// stripLine helper by construction, so it gets the same fix for free.
const countNullishArrayFallback = (content: string): number => {
  let total = 0;
  let inBlockComment = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code: lineCode, state } = stripLine(raw, literalState);
    literalState = state;
    const blockResult = stripBlockComments(lineCode, inBlockComment);
    const code = blockResult.code;
    inBlockComment = blockResult.inBlockComment;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    total += (code.match(NULLISH_ARRAY) ?? []).length;
  }
  return total;
};

const DIRECT_ERROR_MESSAGE =
  /\berror\s+instanceof\s+Error\s*\?\s*error\.message\b|\berror\.message\s*\?\?|\bresult\.error\.message\s*\?\?|\bAPIError\.is\([^)]*\)\s*&&[\s\S]{0,120}?\berror\.message\b/gu;

const countDirectErrorMessageDisplay = (content: string): number => {
  const strippedLines: string[] = [];
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;
    if (COMMENT_LINE.test(code)) {
      strippedLines.push("");
      continue;
    }
    strippedLines.push(code);
  }

  const strippedContent = strippedLines.join("\n");
  return (strippedContent.match(DIRECT_ERROR_MESSAGE) ?? []).length;
};

// Barrel files are selected by the include glob; every matched file counts as
// one barrel (presence metric).
const countPresence = (): number => 1;

// A module-scope `const`/`let` assigned `new Map(...)`/`new Set(...)`, i.e. a
// mutable collection that lives for the lifetime of the module (a tab can
// keep it open for days), never anchored to a component lifecycle. `\b`
// after `Map`/`Set` deliberately does NOT match `WeakMap`/`WeakSet` — those
// are GC-safe by construction (keys drop out once nothing else references
// them) and are excluded from this metric on purpose. The `^` anchor (no
// leading whitespace) is the "module scope, not inside a function" heuristic:
// a declaration indented under a function/hook is scoped to that call, not
// the module.
const MODULE_MUTABLE_COLLECTION =
  /^(?:export\s+)?(?:const|let)\s+\w+\s*(?::.+?)?=\s*new\s+(?:Map|Set)\b/u;

const countModuleLevelMutableCollections = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    if (MODULE_MUTABLE_COLLECTION.test(code)) {
      total += 1;
    }
  }
  return total;
};

// A disable directive for the no-raw-use-effect rule. Literal-stripping first
// keeps a directive spelled inside a string (docs, rule messages) from
// counting; the directive itself is a `//` comment and survives the strip.
const RAW_USE_EFFECT_DISABLE =
  /\/\/\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\b[^\n]*no-raw-use-effect\/no-raw-use-effect/u;

const countRawUseEffectSuppressions = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripStringLiterals(raw, literalState);
    literalState = state;
    if (RAW_USE_EFFECT_DISABLE.test(code)) {
      total += 1;
    }
  }
  return total;
};

// A disable directive for ANY rule (either linter, any variant, `//` or `/*`
// comment form). Whole-repo superset of the per-rule counter above: that one
// keeps its own burn-down, this one freezes TOTAL suppression pressure so an
// improvement on one rule cannot silently fund new suppressions elsewhere.
const LINT_DISABLE_DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u;

const countLintSuppressions = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripStringLiterals(raw, literalState);
    literalState = state;
    if (LINT_DISABLE_DIRECTIVE.test(code)) {
      total += 1;
    }
  }
  return total;
};

// A compiler-suppression directive. Fidelity limit: a prose comment that
// STARTS with the directive token (`// @ts-expect-error is bad`) counts, one
// that merely mentions it mid-sentence does not; directives and leading
// mentions are lexically identical, and the noise is stable so the ratchet
// still only moves on real changes.
const TS_SUPPRESSION_DIRECTIVE =
  /(?:\/\/|\/\*)\s*@ts-(?:expect-error|ignore|nocheck)\b/u;

const countTsSuppressions = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripStringLiterals(raw, literalState);
    literalState = state;
    if (TS_SUPPRESSION_DIRECTIVE.test(code)) {
      total += 1;
    }
  }
  return total;
};

// --- Cross-slice import counters ---------------------------------------------
// Vertical slices (AGENTS.md): API handler domains, web route dirs (their
// `-`-prefixed route-private paths), and web feature dirs are independent
// end-to-end slices; an import reaching across them couples slices. These
// counters extract module specifiers per line and resolve them against the
// importing file's path. Deliberately NOT literal-stripped: import specifiers
// ARE string literals. Fidelity limits: the specifier must sit on the same
// line as its `from`/`import(`/`import` keyword (oxfmt formats imports that
// way), and an import-shaped string inside a template literal would count
// (stable noise; none today).
const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

const API_HANDLERS_PREFIX = "apps/api/src/handlers/";
const WEB_ROUTES_PREFIX = "apps/web/src/routes/";
const WEB_FEATURES_PREFIX = "apps/web/src/features/";
const WEB_ALIAS_PREFIX = "@/";
const WEB_ALIAS_ROOT = "apps/web/src";

// Repo-relative path a specifier resolves to, or null for package imports.
const resolveSpecifier = (file: string, spec: string): string | null => {
  if (spec.startsWith(WEB_ALIAS_PREFIX)) {
    return path.posix.join(WEB_ALIAS_ROOT, spec.slice(WEB_ALIAS_PREFIX.length));
  }
  if (spec.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), spec),
    );
  }
  return null;
};

// First path segment of `p` after `prefix` (the slice name), or null when `p`
// is not under `prefix`.
const sliceOf = (p: string, prefix: string): string | null => {
  if (!p.startsWith(prefix)) {
    return null;
  }
  const segment = p.slice(prefix.length).split("/").at(0);
  return segment !== undefined && segment.length > 0 ? segment : null;
};

// Path remainder inside a slice (`""` when the specifier targets the slice
// root itself, e.g. `../skills` — which is either a loose shared FILE under
// the prefix or a barrel import; neither resolvable without the filesystem,
// both excluded on purpose).
const restWithinSlice = (p: string, prefix: string, slice: string): string =>
  p.slice(Math.min(p.length, prefix.length + slice.length + 1));

type CrossSliceRule = (file: string, resolved: string) => boolean;

const crossesHandlerDomain: CrossSliceRule = (file, resolved) => {
  const from = sliceOf(file, API_HANDLERS_PREFIX);
  const to = sliceOf(resolved, API_HANDLERS_PREFIX);
  if (from === null || to === null || to === from) {
    return false;
  }
  return restWithinSlice(resolved, API_HANDLERS_PREFIX, to).length > 0;
};

// `-`-prefixed segments are route-private by TanStack convention; reaching
// one from outside its TOP-LEVEL route dir (nested dirs like
// `_protected.workspaces/$workspaceId/...` belong to `_protected.workspaces`)
// couples route slices.
const ROUTE_PRIVATE_SEGMENT = /(?:^|\/)-/u;

const crossesRoutePrivate: CrossSliceRule = (file, resolved) => {
  const to = sliceOf(resolved, WEB_ROUTES_PREFIX);
  if (to === null) {
    return false;
  }
  const rest = restWithinSlice(resolved, WEB_ROUTES_PREFIX, to);
  if (!ROUTE_PRIVATE_SEGMENT.test(rest)) {
    return false;
  }
  return sliceOf(file, WEB_ROUTES_PREFIX) !== to;
};

const crossesFeature: CrossSliceRule = (file, resolved) => {
  const from = sliceOf(file, WEB_FEATURES_PREFIX);
  const to = sliceOf(resolved, WEB_FEATURES_PREFIX);
  return from !== null && to !== null && to !== from;
};

const countCrossSliceImports =
  (crosses: CrossSliceRule): FileCounter =>
  (content, file) => {
    let total = 0;
    for (const raw of content.split("\n")) {
      if (COMMENT_LINE.test(raw)) {
        continue;
      }
      for (const match of raw.matchAll(MODULE_SPECIFIER)) {
        const spec = match[1];
        if (spec === undefined) {
          continue;
        }
        const resolved = resolveSpecifier(file, spec);
        if (resolved !== null && crosses(file, resolved)) {
          total += 1;
        }
      }
    }
    return total;
  };

// --- Metric table -----------------------------------------------------------

type FileCounter = (content: string, file: string) => number;

type RatchetMetric = {
  readonly id: string;
  readonly description: string;
  readonly include: readonly string[];
  readonly exclude: (file: string) => boolean;
  readonly count: FileCounter;
};

const RATCHET_METRICS: readonly RatchetMetric[] = [
  {
    id: "as-casts",
    description:
      "`as` type assertions in app source (excl. `as const`, import aliases, tests/gen/d.ts)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countAsCasts,
  },
  {
    id: "nullish-array-fallback",
    description:
      "`?? []` fallbacks in app source (structural invariants should panic() instead)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countNullishArrayFallback,
  },
  {
    id: "barrel-index-files",
    description:
      "index.ts/index.tsx barrel files under apps/{api,web}/src (packages entry points and TanStack route index files excluded)",
    include: [
      "apps/api/src/**/index.{ts,tsx}",
      "apps/web/src/**/index.{ts,tsx}",
    ],
    // TanStack Router index routes (apps/web/src/routes/**/index.tsx) are route
    // files, not barrels — a new index route must not trip the ratchet.
    exclude: (file) =>
      isExcludedSource(file) || file.includes("apps/web/src/routes/"),
    count: countPresence,
  },
  {
    id: "direct-error-message-display",
    description:
      "direct display of raw error.message/result.error.message in web source; prefer translated fallbacks and userError helpers",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: (file) =>
      isExcludedSource(file) ||
      file === "apps/web/src/lib/errors/index.ts" ||
      file.includes("apps/web/src/routes/dev/") ||
      file.startsWith("apps/web/src/workers/"),
    count: countDirectErrorMessageDisplay,
  },
  {
    id: "module-level-mutable-collections",
    description:
      "module-scope `new Map(`/`new Set(` assignments in web source (per-thread/entity registries that never evict); WeakMap/WeakSet excluded (GC-safe by construction)",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countModuleLevelMutableCollections,
  },
  {
    id: "raw-use-effect-suppressions",
    description:
      "no-raw-use-effect disable directives in apps/web/src (each is a reviewed exception; new effects use the wrappers or a better primitive — see /conventions-use-effect)",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countRawUseEffectSuppressions,
  },
  {
    id: "lint-suppression-directives",
    description:
      "eslint-/oxlint-disable directives in app source, any rule (whole-repo suppression pressure; superset of the per-rule raw-use-effect metric — overlap intentional)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countLintSuppressions,
  },
  {
    id: "ts-suppression-directives",
    description:
      "@ts-expect-error/@ts-ignore/@ts-nocheck directives in app source (each hides a type error from the compiler)",
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countTsSuppressions,
  },
  {
    id: "cross-handler-imports",
    description:
      "imports crossing API handler domains (handlers/<a> -> handlers/<b>/...); handler domains are vertical slices — shared code belongs in apps/api/src/lib",
    include: ["apps/api/src/handlers/**/*.ts"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesHandlerDomain),
  },
  {
    id: "cross-route-private-imports",
    description:
      "imports reaching into another top-level route dir's `-`-private paths (TanStack route slices); move shared code to components/, lib/, or a feature dir",
    include: ["apps/web/src/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesRoutePrivate),
  },
  {
    id: "cross-feature-imports",
    description:
      "imports crossing web feature slices (features/<a> -> features/<b>); features are independent end-to-end slices",
    include: ["apps/web/src/features/**/*.{ts,tsx}"],
    exclude: isExcludedSource,
    count: countCrossSliceImports(crossesFeature),
  },
];

// --- Scanning ---------------------------------------------------------------

type MetricSnapshot = { count: number; files: Record<string, number> };
type Baseline = Record<string, MetricSnapshot>;

const scanMetric = (metric: RatchetMetric, root: string): MetricSnapshot => {
  const seen = new Set<string>();
  const perFile: Record<string, number> = {};
  let count = 0;

  for (const glob of metric.include) {
    for (const rel of new Bun.Glob(glob).scanSync(root)) {
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      if (metric.exclude(rel)) {
        continue;
      }
      const n = metric.count(readFileSync(path.join(root, rel), "utf-8"), rel);
      if (n > 0) {
        perFile[rel] = n;
        count += n;
      }
    }
  }

  const files: Record<string, number> = {};
  for (const rel of Object.keys(perFile).sort()) {
    files[rel] = perFile[rel];
  }
  return { count, files };
};

const scanAll = (root: string): Baseline => {
  const snapshot: Baseline = {};
  for (const metric of RATCHET_METRICS) {
    snapshot[metric.id] = scanMetric(metric, root);
  }
  return snapshot;
};

const readBaseline = (): Baseline =>
  JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

const writeBaseline = (snapshot: Baseline): void => {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
};

// --- Diffing ----------------------------------------------------------------

type MetricStatus = "ok" | "regressed" | "dropped";

type RegressedFile = { file: string; from: number; to: number };

type MetricDiff = {
  id: string;
  status: MetricStatus;
  current: number;
  baseline: number;
  regressedFiles: RegressedFile[];
};

const metricStatus = (current: number, baseline: number): MetricStatus => {
  if (current > baseline) {
    return "regressed";
  }
  if (current < baseline) {
    return "dropped";
  }
  return "ok";
};

const diffMetric = (
  id: string,
  current: MetricSnapshot,
  baseline: MetricSnapshot,
): MetricDiff => {
  const regressedFiles: RegressedFile[] = [];
  for (const [file, to] of Object.entries(current.files)) {
    const from = baseline.files[file] ?? 0;
    if (to > from) {
      regressedFiles.push({ file, from, to });
    }
  }
  regressedFiles.sort((a, b) => a.file.localeCompare(b.file));

  const status = metricStatus(current.count, baseline.count);

  return {
    id,
    status,
    current: current.count,
    baseline: baseline.count,
    regressedFiles,
  };
};

// --- Modes ------------------------------------------------------------------

const formatDelta = (delta: number): string => {
  if (delta > 0) {
    return `+${delta}`;
  }
  if (delta < 0) {
    return `${delta}`;
  }
  return "0";
};

const runReport = (): number => {
  const current = scanAll(REPO_ROOT);
  const baseline = readBaseline();
  const showDetails = process.argv.includes("--details");
  console.log("ratchet: current metric counts (vs baseline)\n");
  for (const metric of RATCHET_METRICS) {
    const c = current[metric.id];
    const b = baseline[metric.id]?.count ?? 0;
    const delta = c.count - b;
    const sign = formatDelta(delta);
    console.log(
      `  ${metric.id.padEnd(30)} ${String(c.count).padStart(5)}  (baseline ${b}, ${sign})`,
    );
    console.log(`  ${" ".repeat(30)} ${metric.description}`);
    if (showDetails) {
      for (const [file, count] of Object.entries(c.files)) {
        console.log(`  ${" ".repeat(30)} ${count}  ${file}`);
      }
    }
  }
  return 0;
};

const runWrite = (): number => {
  const snapshot = scanAll(REPO_ROOT);
  writeBaseline(snapshot);
  console.log(`Wrote ratchet baseline to ${BASELINE_REL}:`);
  for (const metric of RATCHET_METRICS) {
    const snap = snapshot[metric.id];
    console.log(
      `  ${metric.id.padEnd(30)} ${String(snap.count).padStart(5)} across ${Object.keys(snap.files).length} file(s)`,
    );
  }
  return 0;
};

const runCheck = (): number => {
  const current = scanAll(REPO_ROOT);
  const baseline = readBaseline();

  const regressions: MetricDiff[] = [];
  const drops: MetricDiff[] = [];

  for (const metric of RATCHET_METRICS) {
    const base = baseline[metric.id] ?? { count: 0, files: {} };
    const diff = diffMetric(metric.id, current[metric.id], base);
    if (diff.status === "regressed") {
      regressions.push(diff);
    }
    if (diff.status === "dropped") {
      drops.push(diff);
    }
  }

  for (const diff of drops) {
    console.log(
      `ratchet: ${diff.id} dropped ${diff.baseline} -> ${diff.current}. Nice — run \`${WRITE_HINT}\` and commit ${BASELINE_REL} to lock it in.`,
    );
  }

  if (regressions.length === 0) {
    console.log(
      `ratchet --check: OK. ${RATCHET_METRICS.length} metric(s) at or below baseline.`,
    );
    return 0;
  }

  console.error("\nratchet --check: metric(s) rose above baseline:\n");
  for (const diff of regressions) {
    console.error(
      `  ${diff.id}: ${diff.baseline} -> ${diff.current} (+${diff.current - diff.baseline})`,
    );
    for (const { file, from, to } of diff.regressedFiles) {
      console.error(`      ${file}: ${from} -> ${to}`);
    }
  }
  console.error(
    "\nThese metrics may only decrease. Remove the new occurrence(s) above, or,\n" +
      `if the increase is genuinely justified, run \`${WRITE_HINT}\` and commit\n` +
      `${BASELINE_REL} with a rationale in your PR.`,
  );
  return 1;
};

// --- Self-test --------------------------------------------------------------
// Materialize synthetic fixtures under a temp repo root, run the real metric
// globs + counters over them, and assert exact counts. Also exercise the diff
// so a rise fails and an equal count passes.

// Lines are authored as an array (one line, one string) so quote characters
// inside the fixture never have to fight the outer template literal's own
// escaping rules.
const AS_CAST_FIXTURE_LINES = [
  'import { foo as bar } from "./x";',
  'export * as ns from "./y";',
  "import {",
  "  wide as narrow,",
  "  other as thing,",
  '} from "./multi";',
  "const a = value as Widget;",
  "const b = value as const;",
  "const c = value as unknown as Widget;",
  "// prose that says as much as it can",
  "const d = (value as readonly string[]).length; // trailing as comment",
  'const label1 = "stored as json"; // double-quoted string must not count',
  "const label2 = 'stored as json'; // single-quoted string must not count",
  "const label3 = `stored as json`; // template-literal string must not count",
  'const escaped = "a \\" as \\" b"; // escaped quote must not end the string early',
  'const real = (value as string) + "not as this" + (other as number);',
  'const url = ("http://example.com" as string).length; // "//" in a string must not eat the rest of the line',
  "const tmpl = `first line: as if it mattered",
  "second line: also as filler",
  "end` as Widget;",
  `type Remapped<T> = { [K in keyof T as \`get\${K & string}\`]: T[K] };`,
];
const SELF_TEST_AS_CASTS = `${AS_CAST_FIXTURE_LINES.join("\n")}\n`;
// Expected as-casts: `a`(1), `c` collapsed(1), `d`(1), `real`'s two casts(2),
// `url`'s cast(1), the cast right after the multi-line template closes(1) = 7.
// The single-line alias imports, the MULTI-LINE import block (its
// `wide as narrow` / `other as thing` continuation lines), `as const`, the
// pure-comment line, all three string-literal false positives (double/single/
// template quoted), the escaped-quote string, the "as" text inside the
// multi-line template body, and the "//" inside the url string are all
// excluded.
const EXPECTED_AS_CASTS = 7;

const NULLISH_FIXTURE_LINES = [
  "const a = list ?? [];",
  "const b = other ??[];",
  "const c = map ?? {};",
  "// fallback ?? [] in a comment must not count",
  "const d = both ?? [] ?? [];",
  'const e = "danger ?? [] in a string"; // string must not count',
  "const f = 'danger ?? [] in a string'; // string must not count",
  "const g = `danger ?? [] in a string`; // template string must not count",
  'const h = (list ?? []) + "not ?? [] in this string";',
];
const SELF_TEST_NULLISH = `${NULLISH_FIXTURE_LINES.join("\n")}\n`;
// Expected: a(1) + b(1) + d(2) + h(1) = 5; `?? {}`, the comment, and the
// string/template false positives (e, f, g) are excluded.
const EXPECTED_NULLISH = 5;

const DIRECT_ERROR_FIXTURE_LINES = [
  "stellaToast.add({ title: error instanceof Error ? error.message : fallback });",
  "stellaToast.add({ title: error.message ?? fallback });",
  "stellaToast.add({ title: result.error.message ?? fallback });",
  "if (APIError.is(error) &&",
  "    error.message) {",
  "const internal = userErrorMessage(response.error, fallback);",
  'const literal = "error.message ?? fallback";',
  "// error instanceof Error ? error.message : fallback",
];
const SELF_TEST_DIRECT_ERROR = `${DIRECT_ERROR_FIXTURE_LINES.join("\n")}\n`;
// Expected: four direct user-facing-ish raw-message displays; helper use,
// string literal, and comment are excluded.
const EXPECTED_DIRECT_ERROR = 4;

const MODULE_COLLECTION_FIXTURE_LINES = [
  "const frozenSet = new Set([1, 2, 3]);",
  "export const exportedRegistry = new Map<string, number>();",
  "let mutableCounter = new Set<string>();",
  'const typed: ReadonlySet<string> = new Set(["a"]);',
  "const withArrowType: Map<string, () => void> = new Map();",
  "const multiline = new Map<",
  "  string,",
  "  number",
  ">();",
  "const weakOk = new WeakMap<object, number>();",
  "const weakSetOk = new WeakSet<object>();",
  "function useLocalCache() {",
  "  const indented = new Map<string, number>();",
  "  return indented;",
  "}",
  "// const commentedOut = new Map();",
];
const SELF_TEST_MODULE_COLLECTIONS = `${MODULE_COLLECTION_FIXTURE_LINES.join("\n")}\n`;
// Expected: frozenSet(1) + exportedRegistry(1) + mutableCounter(1) + typed(1)
// + withArrowType(1) + multiline(1, counted on its opening line even though
// `new Map<` spans to a later `>()`) = 6. WeakMap/WeakSet, the indented
// (function-scoped)
// declaration, and the commented-out line are all excluded.
const EXPECTED_MODULE_COLLECTIONS = 6;

const LINT_SUPPRESSION_FIXTURE_LINES = [
  "// eslint-disable-next-line no-console -- reason one",
  "// oxlint-disable-next-line some-plugin/some-rule -- reason two",
  "/* eslint-disable no-console */",
  "// oxlint-disable",
  'const doc = "// eslint-disable-next-line fake"; // directive in a string must not count',
  "// eslint disables discussed in prose (no hyphenated directive) must not count",
];
const SELF_TEST_LINT_SUPPRESSIONS = `${LINT_SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// Expected from THIS fixture: both linters' -next-line forms, the block-
// comment form, and the bare `oxlint-disable` = 4. The string copy and the
// prose comment are excluded. NOTE: the raw-use-effect fixture below also
// contains 3 directives (its two rule-specific ones plus the other-rule one),
// and this metric scans both apps, so the whole-repo expectation is 4 + 3.
const EXPECTED_LINT_SUPPRESSIONS_OWN_FILE = 4;
const EXPECTED_LINT_SUPPRESSIONS_TOTAL = 7;

const TS_SUPPRESSION_FIXTURE_LINES = [
  "// @ts-expect-error legacy upstream shape",
  "// @ts-ignore",
  "/* @ts-nocheck */",
  'const s = "// @ts-ignore inside a string"; // must not count',
  "// removing the last @ts-expect-error is the goal (mid-sentence mention must not count)",
];
const SELF_TEST_TS_SUPPRESSIONS = `${TS_SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// Expected: the three directive lines; the string copy and the mid-sentence
// mention are excluded.
const EXPECTED_TS_SUPPRESSIONS = 3;

const CROSS_HANDLER_FIXTURE_LINES = [
  'import { origin } from "../skills/origin";',
  'import { local } from "./local-helper";',
  'import { schema } from "../pagination-limit-schema";',
  'import { db } from "../../db";',
  'const lazy = await import("../docx/extract-text");',
  '// import { c } from "../skills/commented";',
];
const SELF_TEST_CROSS_HANDLER = `${CROSS_HANDLER_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in handlers/catalogue/): the ../skills/ static import
// and the ../docx/ dynamic import = 2. Same-domain, slice-root (a loose
// shared file directly under handlers/ resolves with an empty rest and is
// excluded on purpose), outside-handlers, and commented imports don't count.
const EXPECTED_CROSS_HANDLER = 2;

const CROSS_ROUTE_FIXTURE_LINES = [
  'import { w } from "@/routes/_protected.alpha/-components/widget";',
  'import { q } from "../_protected.alpha/-queries";',
  'import { own } from "./-components/own-widget";',
  'import { deep } from "@/routes/_protected.alpha/$id/-hooks/use-x";',
  'import { pub } from "@/routes/_protected.alpha/shared-public";',
  'import { Button } from "@coss/button";',
  '// import { c } from "@/routes/_protected.alpha/-components/commented";',
];
const SELF_TEST_CROSS_ROUTE = `${CROSS_ROUTE_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in routes/_protected.beta/): alias cross-import,
// relative cross-import, and the nested `-hooks` under the other slice = 3.
// Own-slice private, other-slice non-private, package, and commented imports
// don't count.
const EXPECTED_CROSS_ROUTE_BETA = 3;

const CROSS_ROUTE_NESTED_FIXTURE_LINES = [
  'import { own } from "@/routes/_protected.alpha/-queries";',
  'import { other } from "@/routes/_protected.beta/-queries";',
];
const SELF_TEST_CROSS_ROUTE_NESTED = `${CROSS_ROUTE_NESTED_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in routes/_protected.alpha/$id/, i.e. slice
// `_protected.alpha`): only the `_protected.beta` reach counts; the own-slice
// import from a NESTED dir proves attribution to the top-level route dir.
const EXPECTED_CROSS_ROUTE_NESTED = 1;

const CROSS_ROUTE_CHROME_FIXTURE_LINES = [
  'import { q } from "@/routes/_protected.alpha/-queries";',
  'import { util } from "@/lib/utils";',
];
const SELF_TEST_CROSS_ROUTE_CHROME = `${CROSS_ROUTE_CHROME_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives OUTSIDE routes/, in components/): shared chrome
// reaching into any route-private path counts = 1.
const EXPECTED_CROSS_ROUTE_CHROME = 1;

const CROSS_FEATURE_FIXTURE_LINES = [
  'import { b } from "../beta/utils";',
  'import { own } from "./own-utils";',
  'import { shared } from "@/lib/utils";',
  'import { viaAlias } from "@/features/beta/other";',
];
const SELF_TEST_CROSS_FEATURE = `${CROSS_FEATURE_FIXTURE_LINES.join("\n")}\n`;
// Expected (file lives in features/alpha/): the relative and alias imports
// into features/beta = 2; own-feature and non-feature imports don't count.
const EXPECTED_CROSS_FEATURE = 2;

const SUPPRESSION_FIXTURE_LINES = [
  "// eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reason one",
  "useEffect(() => {}, []);",
  "  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reason two",
  "useEffect(() => {}, []);",
  'const doc = "// eslint-disable-next-line no-raw-use-effect/no-raw-use-effect"; // directive in a string must not count',
  "// the no-raw-use-effect/no-raw-use-effect rule is discussed here without a disable directive",
  "// eslint-disable-next-line react-hooks/exhaustive-deps -- other-rule directive must not count",
];
const SELF_TEST_SUPPRESSIONS = `${SUPPRESSION_FIXTURE_LINES.join("\n")}\n`;
// Expected: the two disable directives; the string-literal copy, the prose
// comment without a disable, and the other-rule directive are excluded.
const EXPECTED_SUPPRESSIONS = 2;

const writeFixture = (root: string, rel: string, content: string): void => {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const runSelfTest = (): number => {
  const failures: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-selftest-"));

  try {
    writeFixture(root, "apps/api/src/casts.ts", SELF_TEST_AS_CASTS);
    writeFixture(root, "apps/web/src/nullish.ts", SELF_TEST_NULLISH);
    writeFixture(
      root,
      "apps/web/src/error-display.tsx",
      SELF_TEST_DIRECT_ERROR,
    );
    writeFixture(
      root,
      "apps/web/src/module-collections.ts",
      SELF_TEST_MODULE_COLLECTIONS,
    );
    writeFixture(
      root,
      "apps/web/src/effect-suppressions.tsx",
      SELF_TEST_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/src/lint-suppressions.ts",
      SELF_TEST_LINT_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/src/ts-suppressions.ts",
      SELF_TEST_TS_SUPPRESSIONS,
    );
    writeFixture(
      root,
      "apps/api/src/handlers/catalogue/uses-skills.ts",
      SELF_TEST_CROSS_HANDLER,
    );
    writeFixture(
      root,
      "apps/web/src/routes/_protected.beta/uses-alpha.tsx",
      SELF_TEST_CROSS_ROUTE,
    );
    writeFixture(
      root,
      "apps/web/src/routes/_protected.alpha/$id/nested.tsx",
      SELF_TEST_CROSS_ROUTE_NESTED,
    );
    writeFixture(
      root,
      "apps/web/src/components/chrome.tsx",
      SELF_TEST_CROSS_ROUTE_CHROME,
    );
    writeFixture(
      root,
      "apps/web/src/features/alpha/uses-beta.ts",
      SELF_TEST_CROSS_FEATURE,
    );
    writeFixture(root, "apps/api/src/db/index.ts", "export const x = 1;\n");
    writeFixture(root, "apps/web/src/lib/index.tsx", "export const y = 2;\n");
    // Excluded companions: these must NOT be counted.
    writeFixture(
      root,
      "apps/api/src/casts.test.ts",
      "const z = value as Widget;\n",
    );
    writeFixture(root, "apps/web/src/types.gen.ts", "const g = x as Y;\n");

    const snapshot = scanAll(root);

    const asMetric = snapshot["as-casts"];
    if (asMetric.count !== EXPECTED_AS_CASTS) {
      failures.push(
        `as-casts counted ${asMetric.count}, expected ${EXPECTED_AS_CASTS}`,
      );
    }
    if ("apps/api/src/casts.test.ts" in asMetric.files) {
      failures.push("as-casts did not exclude a .test.ts file");
    }
    if ("apps/web/src/types.gen.ts" in asMetric.files) {
      failures.push("as-casts did not exclude a .gen.ts file");
    }

    const nullishMetric = snapshot["nullish-array-fallback"];
    if (nullishMetric.count !== EXPECTED_NULLISH) {
      failures.push(
        `nullish-array-fallback counted ${nullishMetric.count}, expected ${EXPECTED_NULLISH}`,
      );
    }

    const barrelMetric = snapshot["barrel-index-files"];
    if (barrelMetric.count !== 2) {
      failures.push(
        `barrel-index-files counted ${barrelMetric.count}, expected 2`,
      );
    }

    const directErrorMetric = snapshot["direct-error-message-display"];
    if (directErrorMetric.count !== EXPECTED_DIRECT_ERROR) {
      failures.push(
        `direct-error-message-display counted ${directErrorMetric.count}, expected ${EXPECTED_DIRECT_ERROR}`,
      );
    }

    const moduleCollectionsMetric =
      snapshot["module-level-mutable-collections"];
    if (moduleCollectionsMetric.count !== EXPECTED_MODULE_COLLECTIONS) {
      failures.push(
        `module-level-mutable-collections counted ${moduleCollectionsMetric.count}, expected ${EXPECTED_MODULE_COLLECTIONS}`,
      );
    }

    const suppressionMetric = snapshot["raw-use-effect-suppressions"];
    if (suppressionMetric.count !== EXPECTED_SUPPRESSIONS) {
      failures.push(
        `raw-use-effect-suppressions counted ${suppressionMetric.count}, expected ${EXPECTED_SUPPRESSIONS}`,
      );
    }

    const lintSuppressionMetric = snapshot["lint-suppression-directives"];
    if (lintSuppressionMetric.count !== EXPECTED_LINT_SUPPRESSIONS_TOTAL) {
      failures.push(
        `lint-suppression-directives counted ${lintSuppressionMetric.count}, expected ${EXPECTED_LINT_SUPPRESSIONS_TOTAL}`,
      );
    }
    if (
      lintSuppressionMetric.files["apps/api/src/lint-suppressions.ts"] !==
      EXPECTED_LINT_SUPPRESSIONS_OWN_FILE
    ) {
      failures.push(
        `lint-suppression-directives per-file count for the dedicated fixture was ${lintSuppressionMetric.files["apps/api/src/lint-suppressions.ts"]}, expected ${EXPECTED_LINT_SUPPRESSIONS_OWN_FILE}`,
      );
    }

    const tsSuppressionMetric = snapshot["ts-suppression-directives"];
    if (tsSuppressionMetric.count !== EXPECTED_TS_SUPPRESSIONS) {
      failures.push(
        `ts-suppression-directives counted ${tsSuppressionMetric.count}, expected ${EXPECTED_TS_SUPPRESSIONS}`,
      );
    }

    const crossHandlerMetric = snapshot["cross-handler-imports"];
    if (crossHandlerMetric.count !== EXPECTED_CROSS_HANDLER) {
      failures.push(
        `cross-handler-imports counted ${crossHandlerMetric.count}, expected ${EXPECTED_CROSS_HANDLER}`,
      );
    }

    const crossRouteMetric = snapshot["cross-route-private-imports"];
    const expectedCrossRouteTotal =
      EXPECTED_CROSS_ROUTE_BETA +
      EXPECTED_CROSS_ROUTE_NESTED +
      EXPECTED_CROSS_ROUTE_CHROME;
    if (crossRouteMetric.count !== expectedCrossRouteTotal) {
      failures.push(
        `cross-route-private-imports counted ${crossRouteMetric.count}, expected ${expectedCrossRouteTotal}`,
      );
    }
    if (
      crossRouteMetric.files[
        "apps/web/src/routes/_protected.alpha/$id/nested.tsx"
      ] !== EXPECTED_CROSS_ROUTE_NESTED
    ) {
      failures.push(
        "cross-route-private-imports did not attribute a nested route file to its top-level slice",
      );
    }

    const crossFeatureMetric = snapshot["cross-feature-imports"];
    if (crossFeatureMetric.count !== EXPECTED_CROSS_FEATURE) {
      failures.push(
        `cross-feature-imports counted ${crossFeatureMetric.count}, expected ${EXPECTED_CROSS_FEATURE}`,
      );
    }

    // Diff behavior: equal passes, a rise regresses, a fall is a drop.
    const equal = diffMetric(
      "as-casts",
      { count: 4, files: { "a.ts": 4 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (equal.status !== "ok") {
      failures.push("diffMetric flagged an equal count as not ok");
    }

    const rose = diffMetric(
      "as-casts",
      { count: 5, files: { "a.ts": 5 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (rose.status !== "regressed" || rose.regressedFiles.length !== 1) {
      failures.push("diffMetric did not flag an increased count as regressed");
    }

    const fell = diffMetric(
      "as-casts",
      { count: 3, files: { "a.ts": 3 } },
      { count: 4, files: { "a.ts": 4 } },
    );
    if (fell.status !== "dropped") {
      failures.push("diffMetric did not flag a decreased count as dropped");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("ratchet --self-test: FAIL");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  console.log("ratchet --self-test: PASS");
  return 0;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write")) {
    return runWrite();
  }
  if (process.argv.includes("--check")) {
    return runCheck();
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
