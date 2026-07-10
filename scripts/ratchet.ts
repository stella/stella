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
//
// `keepDelimiters` blanks only the INTERIOR of the literal, leaving the
// opening/closing quote characters in place (`"foo"` -> `" "` rather than
// ` `). Most counters don't need this — the quote chars are noise — but
// `countRawDateParsing` matches on the opening quote itself
// (`new Date("`), which a full blank would erase along with the rest of
// the string it's trying to detect.
const stripStringLiterals = (
  raw: string,
  state: LiteralScanState,
  keepDelimiters = false,
): { code: string; state: LiteralScanState } => {
  let out = "";
  let i = 0;

  if (state.inTemplate) {
    const close = findUnescapedQuote(raw, 0, "`");
    if (close === -1) {
      return { code: out, state };
    }
    out += keepDelimiters ? `${BLANKED_LITERAL}\`` : BLANKED_LITERAL;
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
      out += keepDelimiters
        ? `${ch}${BLANKED_LITERAL}${raw[close]}`
        : BLANKED_LITERAL;
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
  keepDelimiters = false,
): { code: string; state: LiteralScanState } => {
  const { code, state: nextState } = stripStringLiterals(
    raw,
    state,
    keepDelimiters,
  );
  return { code: code.replace(LINE_COMMENT_TAIL, ""), state: nextState };
};

const countAsCasts = (content: string): number => {
  let total = 0;
  let inModuleStmt = false;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;

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
    const scanned = code.replace(AS_UNKNOWN_AS, AS_UNKNOWN_PLACEHOLDER);
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
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState);
    literalState = state;
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

// Raw date/timezone footguns: `new Date("YYYY-MM-DD")` parses as UTC
// midnight (an off-by-one day once rendered west of UTC), `Date.parse(...)`
// of a non-ISO string is engine-dependent, and day-length millisecond
// arithmetic used for CALENDAR math (`24 * 60 * 60 * 1000`,
// `86_400_000`/`86400000`) breaks across a DST transition (the clocks-change
// day is 23 or 25 hours, not 24). Use `parseIsoDateLocal` / `addDays` from
// `apps/{api,web}/src/lib/dates.ts` for calendar/date-boundary work instead.
//
// NOT a footgun: the same millisecond literal used as a fixed-duration span
// (a TTL, a timeout, a "how many ms have elapsed" comparison) rather than a
// calendar offset. `Date.now() + 24 * 60 * 60 * 1000` for a token that must
// expire exactly 86,400,000ms after issuance is correct — converting it to
// `addDays` would make the expiry drift by an hour across a DST transition,
// which is the opposite of what this ratchet wants. This counter can't tell
// the two apart lexically (that requires understanding whether the result
// feeds a calendar boundary or a raw duration comparison), so it flags both;
// treat a flagged fixed-duration constant as a false positive to leave alone,
// not a violation to "fix" into calendar arithmetic.
//
// Line-based, like the counters above, and (like `countAsCasts`) runs
// through `stripLine` so a `//` sitting inside an earlier string on the same
// line (e.g. a URL) can't truncate the line before a later real match.
// Unlike the other counters, it passes `keepDelimiters: true` — the string
// quote characters themselves are part of what `RAW_DATE_STRING_ARG` matches
// (`new Date("`), so only the literal's interior is blanked, not the quotes.
const RAW_DATE_STRING_ARG = /\bnew\s+Date\(\s*["`]/gu;
const DATE_PARSE_CALL = /\bDate\.parse\(/gu;
const DAY_MS_ARITHMETIC_EXPR = /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\b/gu;
const DAY_MS_LITERAL = /\b86_400_000\b|\b86400000\b/gu;
const KEEP_QUOTE_DELIMITERS = true;

const countRawDateParsing = (content: string): number => {
  let total = 0;
  let literalState = NO_OPEN_TEMPLATE;

  for (const raw of content.split("\n")) {
    const { code, state } = stripLine(raw, literalState, KEEP_QUOTE_DELIMITERS);
    literalState = state;
    if (COMMENT_LINE.test(code)) {
      continue;
    }
    total += (code.match(RAW_DATE_STRING_ARG) ?? []).length;
    total += (code.match(DATE_PARSE_CALL) ?? []).length;
    total += (code.match(DAY_MS_ARITHMETIC_EXPR) ?? []).length;
    total += (code.match(DAY_MS_LITERAL) ?? []).length;
  }
  return total;
};

// --- Metric table -----------------------------------------------------------

type FileCounter = (content: string) => number;

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
    id: "raw-date-parsing",
    description:
      'string-literal date parsing (`new Date("...")`, `new Date(`...`)`, `Date.parse(...)`) and day-length ms arithmetic used for CALENDAR math (`24 * 60 * 60 * 1000`, `86_400_000`/`86400000`) in app source (excl. tests/gen); prefer `parseIsoDateLocal`/`addDays` from apps/{api,web}/src/lib/dates.ts for date-boundary work. The same ms literal used as a fixed-duration TTL/timeout (not a calendar offset) is correct as-is and must NOT be converted to calendar-day arithmetic — that would introduce DST drift. The counter cannot distinguish the two lexically, so it flags both; a flagged fixed-duration constant is a known false positive, not a violation.',
    include: APP_SOURCE_GLOBS,
    exclude: isExcludedSource,
    count: countRawDateParsing,
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
      const n = metric.count(readFileSync(path.join(root, rel), "utf-8"));
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
  console.log("ratchet: current metric counts (vs baseline)\n");
  for (const metric of RATCHET_METRICS) {
    const c = current[metric.id];
    const b = baseline[metric.id]?.count ?? 0;
    const delta = c.count - b;
    const sign = formatDelta(delta);
    console.log(
      `  ${metric.id.padEnd(24)} ${String(c.count).padStart(5)}  (baseline ${b}, ${sign})`,
    );
    console.log(`  ${" ".repeat(24)} ${metric.description}`);
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
      `  ${metric.id.padEnd(24)} ${String(snap.count).padStart(5)} across ${Object.keys(snap.files).length} file(s)`,
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

const RAW_DATE_FIXTURE_LINES = [
  'const a = new Date("2024-01-01");',
  "const b = new Date(`2024-01-01`);",
  "const c = Date.parse(rawInput);",
  "const d = now.getTime() + 24 * 60 * 60 * 1000;",
  "const e = now.getTime() + 86_400_000;",
  "const f = now.getTime() + 86400000;",
  "const g = new Date(); // no-arg constructor is safe, must not count",
  "const h = new Date(year, month - 1, day); // date-parts ctor is safe",
  "const i = new Date(existingDate); // copying a Date instance is safe",
  '// new Date("2024-01-01") mentioned in a comment must not count',
  "const j = parseIsoDateLocal(iso); // helper call is safe",
  'const withUrl = "see http://example.com for details"; const k = new Date("2024-01-01"); // "//" earlier in the line must not hide this real match',
];
const SELF_TEST_RAW_DATE = `${RAW_DATE_FIXTURE_LINES.join("\n")}\n`;
// Expected: a(1) + b(1) + c(1) + d(1) + e(1) + f(1) + k(1) = 7. The no-arg/
// parts/copy Date constructors, the safe helper call, and the comment
// mention are all excluded. `k` proves the earlier `http://` string (with
// its own `//`) does not truncate the line before the real `new Date(...)`
// call further along it — the false-negative class `stripLine` fixes.
const EXPECTED_RAW_DATE = 7;

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
    writeFixture(root, "apps/api/src/db/index.ts", "export const x = 1;\n");
    writeFixture(root, "apps/web/src/lib/index.tsx", "export const y = 2;\n");
    writeFixture(root, "apps/api/src/raw-date.ts", SELF_TEST_RAW_DATE);
    // Excluded companions: these must NOT be counted.
    writeFixture(
      root,
      "apps/api/src/casts.test.ts",
      "const z = value as Widget;\n",
    );
    writeFixture(root, "apps/web/src/types.gen.ts", "const g = x as Y;\n");
    writeFixture(root, "apps/api/src/raw-date.test.ts", SELF_TEST_RAW_DATE);

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

    const rawDateMetric = snapshot["raw-date-parsing"];
    if (rawDateMetric.count !== EXPECTED_RAW_DATE) {
      failures.push(
        `raw-date-parsing counted ${rawDateMetric.count}, expected ${EXPECTED_RAW_DATE}`,
      );
    }
    if ("apps/api/src/raw-date.test.ts" in rawDateMetric.files) {
      failures.push("raw-date-parsing did not exclude a .test.ts file");
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
