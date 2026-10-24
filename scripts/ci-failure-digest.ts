/**
 * Compact CI failure digest.
 *
 * A failing CI log is mostly noise: thousands of passing test lines, setup
 * output, and deliberate negative-test output that prints `##[error]` from
 * steps that pass. This script reduces a run to one record per failed step:
 * job, step, kind, and the first few actionable lines with `file:line`.
 *
 * Which steps failed comes from the jobs API (step conclusions), never from
 * `##[error]` text, so a step that prints errors on purpose and exits 0 is
 * never reported.
 *
 * Commands:
 *   digest --jobs <jobs.json> --logs <dir> --json <out.json> [--summary <file>]
 *     Reads the run's jobs (as `gh api --paginate --slurp` returns them) and
 *     one `<job id>.log` per failed job. Prints `::error` annotations, writes
 *     the JSON digest and appends a short Markdown summary.
 *   tail <test-output.log>
 *     Prints the failing tests of a test run (with their error lines) so a
 *     failing step's log ends with its failures.
 *
 * Needs no dependency install: node builtins only.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const MAX_LINES_PER_STEP = 5;
export const MAX_LINE_WIDTH = 200;
// GitHub keeps at most 10 error annotations per step.
export const MAX_ANNOTATIONS = 10;
const MAX_TAIL_TESTS = 30;
const MAX_TAIL_DETAIL = 12;
const TAIL_WINDOW = 40;

export type FailureKind =
  | "infra"
  | "test"
  | "typecheck"
  | "lint"
  | "ratchet"
  | "policy"
  | "build"
  | "other";

export type FailureLine = {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
};

/**
 * A failing Bun test as its run printed it: the Turbo scope (package name, or
 * empty), the file header relative to that package, and the full test name.
 * The flaky-test history resolves it to a repository path.
 */
export type FailedTest = {
  readonly scope: string;
  readonly file: string;
  readonly name: string;
};

export type FailureRecord = {
  readonly job: string;
  readonly step: string;
  readonly kind: FailureKind;
  readonly url: string;
  readonly lines: readonly FailureLine[];
  readonly tests: readonly FailedTest[];
};

export const DIGEST_VERSION = 1;

// The `ci-failures.json` artifact. The flaky-test history reads it back, so
// both sides go through this envelope.
export type DigestFile = {
  readonly version: typeof DIGEST_VERSION;
  readonly run_id: string | null;
  readonly run_attempt: string | null;
  readonly failures: readonly FailureRecord[];
};

export const digestFile = (
  failures: readonly FailureRecord[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): DigestFile => ({
  version: DIGEST_VERSION,
  run_id: env["GITHUB_RUN_ID"] ?? null,
  run_attempt: env["GITHUB_RUN_ATTEMPT"] ?? null,
  failures,
});

// ---------------------------------------------------------------------------
// Line normalization

// ANSI CSI and OSC sequences, which start with ESC and OSC ends with BEL.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`,
  "gu",
);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
// Turbo prefixes task output with `<package>:<task>: `.
// Turbo prefixes task output with `<package>:<task>: `; a scoped package can
// also be followed by a space (`@scope/pkg task: `).
const TURBO_PREFIX =
  /^(?:(@[\w.-]+\/[\w.-]+)[: ]|([\w.-]+):)([a-z][\w:-]*): ?/u;
const EXIT_MARKER = /^##\[error\]Process completed with exit code \d+\.?$/u;
const GROUP_RUN = "##[group]Run ";
const BACKGROUND_WAIT = "Waiting for all background step(s)";
const POST_JOB = "Post job cleanup.";

export const stripAnsi = (value: string): string => value.replaceAll(ANSI, "");

export const truncate = (value: string, width = MAX_LINE_WIDTH): string => {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 3)}...`;
};

// Runner work directories repeat the repository name: `.../work/<r>/<r>/`.
const WORKSPACE_PREFIX =
  /^(?:[A-Za-z]:)?[\\/](?:.*?[\\/])?_?work[\\/]([^\\/]+)[\\/]\1[\\/]/u;
const REPOSITORY_ROOTS =
  /^(?:apps|packages|scripts|docs|types|patches|tools|\.github|\.oxlint-plugins|\.claude)\//u;

/** A repository-relative path, or undefined when the path is not one. */
export const repositoryPath = (value: string): string | undefined => {
  let candidate = value.replaceAll("\\", "/");
  const workspace = process.env["GITHUB_WORKSPACE"]?.replaceAll("\\", "/");
  if (workspace && candidate.startsWith(`${workspace}/`)) {
    candidate = candidate.slice(workspace.length + 1);
  } else {
    candidate = candidate.replace(WORKSPACE_PREFIX, "");
  }
  candidate = candidate.replace(/^\.\//u, "");
  if (
    candidate.includes("node_modules/") ||
    !REPOSITORY_ROOTS.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
};

const shortPath = (value: string): string =>
  repositoryPath(value) ??
  value.replaceAll("\\", "/").replace(WORKSPACE_PREFIX, "");

type LogLine = {
  readonly text: string;
  readonly scope: string;
  readonly annotation?: "error" | "continuation";
};

/**
 * Every pattern sees at most this many characters of a line, so one
 * oversized log line costs a bounded amount of work.
 */
export const MAX_SCAN_WIDTH = 2000;

const scanned = (raw: string): string =>
  raw.length > MAX_SCAN_WIDTH ? raw.slice(0, MAX_SCAN_WIDTH) : raw;

const logLine = (raw: string): LogLine => {
  const text = stripAnsi(scanned(raw).replace(TIMESTAMP, "")).replace(
    /\r$/u,
    "",
  );
  const turbo = TURBO_PREFIX.exec(text);
  return turbo
    ? { text: text.slice(turbo[0].length), scope: turbo[1] ?? turbo[2] ?? "" }
    : { text, scope: "" };
};

const logLines = (rawLines: readonly string[]): LogLine[] =>
  rawLines.flatMap((raw) => {
    const line = logLine(raw);
    if (!line.text.startsWith("::error")) {
      return [line];
    }
    const end = line.text.indexOf("::", 2);
    if (end === -1) {
      return [line];
    }
    // Decode only command data, after its header and before line parsing.
    const message = line.text
      .slice(end + 2)
      .replaceAll("%0A", "\n")
      .replaceAll("%0D", "\r")
      .replaceAll("%25", "%");
    return message.split("\n").map((text, index) => ({
      text,
      scope: line.scope,
      annotation: index === 0 ? ("error" as const) : ("continuation" as const),
    }));
  });

// The pool's plain record of a failed check (FAILED_CHECK_RECORD in
// ci-check-pool.ts; a test binds the two). Runner-rendered logs keep it, while
// they reduce the pool's `::error` annotation to its message. The pool prints
// each check's own output inside a log group, so only lines outside a group
// are records.
export const POOLED_FAILURE_PREFIX = "FAILED check: ";
const POOLED_FAILURE_SEPARATOR = " -- ";

// The pool's cause for a check that printed no failed test or error line
// (exitCodeDetail in ci-check-pool.ts; a test binds the two). It says nothing
// about why, so the check's own log group supplies the lines.
export const BARE_EXIT_CAUSE = /^exit code -?\d+$/u;

// The pool opens each check's log group with `<name>: <outcome> in <n> s`.
const POOLED_GROUP_HEADER =
  /^##\[group\](.*): (?:passed|FAILED(?: \(continue-on-error\))?) in [\d.]+ s$/u;

type PooledFailureRecord = {
  readonly name: string;
  readonly cause: string;
  /** The raw lines of the check's own log group, for its failed tests. */
  readonly groupLines: readonly string[];
};

const pooledFailureRecords = (
  rawLines: readonly string[],
): PooledFailureRecord[] => {
  const records: PooledFailureRecord[] = [];
  const groups = new Map<string, string[]>();
  let group: string[] | undefined;
  for (const raw of rawLines) {
    const { text } = logLine(raw);
    if (text.startsWith("##[group]")) {
      group = [];
      const name = POOLED_GROUP_HEADER.exec(text)?.[1];
      if (name !== undefined) {
        groups.set(name, group);
      }
      continue;
    }
    if (text.startsWith("##[endgroup]")) {
      group = undefined;
      continue;
    }
    if (group !== undefined) {
      group.push(raw);
      continue;
    }
    if (!text.startsWith(POOLED_FAILURE_PREFIX)) {
      continue;
    }
    const record = text.slice(POOLED_FAILURE_PREFIX.length);
    const separator = record.indexOf(POOLED_FAILURE_SEPARATOR);
    if (separator === -1) {
      continue;
    }
    // `%25` decodes last, so an escaped `%` never starts another escape.
    const name = record
      .slice(0, separator)
      .replaceAll("%2D", "-")
      .replaceAll("%0A", "\n")
      .replaceAll("%0D", "\r")
      .replaceAll("%25", "%");
    records.push({
      name,
      cause: record.slice(separator + POOLED_FAILURE_SEPARATOR.length),
      groupLines: groups.get(name) ?? [],
    });
  }
  return records;
};

// ---------------------------------------------------------------------------
// Failure extraction

// Patterns stay linear: locations are matched per token and anchored, and
// stack frames, Playwright titles and oxlint headers are split in code.
const TOKEN_SEPARATORS = /[\s"'`<>[\]{};]+/u;
const LOCATION_TOKEN =
  /^((?:[A-Za-z]:)?[^\s:()]+\.(?:[cm]?[jt]sx?|rs|py|sh|ya?ml|json|toml|css|md|sql|go))(?::(\d+)|\((\d+),\d+\))/u;
const DIGITS = /^\d+$/u;
const TSC = /^(.+?)(?:\((\d+),\d+\)|:(\d+):\d+)(?::| -) error (TS\d+): (.*)$/u;
const BUN_RESULT = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$/u;
const BUN_FILE_HEADER = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/u;
const ERROR_HEADLINE =
  /^\s*(?:error:|(?:\w*Error|AssertionError)(?:\s*\[\w+\])?:|Expected|Received|expect\()/u;
const PLAYWRIGHT_HEAD = /^\s*(?:\d+\)|[✘x]\s+\d+) \[([^\]]+)\] › /u;
const PLAYWRIGHT_DURATION = /^[\d.]+m?s$/u;
const OXLINT_LOCATION = /^\s*[,╭]─?-?\[(.+?):(\d+):\d+\]/u;
// oxlint and ESLint rule ids: `typescript(no-base-to-string)`.
const LINT_RULE =
  /\b(?:eslint|typescript|unicorn|oxc|react|react-hooks|import|jsx-a11y|jest|promise|node|regexp|vitest)\([\w-]+\)/u;
const ERRORISH = /\b(?:error|errors|failed|failure|fail)\b/iu;
const ANCHOR =
  /\b(?:error|errors|fail|failed|failure|invalid|violat\w*|regress\w*|mismatch\w*|missing|not allowed|forbidden|must|expected)\b/iu;

/** One failing test with the lines that explain it. */
export type TestFailure = {
  readonly scope: string;
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  /** The Bun file header the result was printed under. */
  readonly source?: string;
  readonly detail: readonly string[];
};

const located = (
  file: string | undefined,
  line: string | undefined,
): { file?: string; line?: number } => {
  const repoPath = file === undefined ? undefined : repositoryPath(file);
  if (repoPath === undefined) {
    return {};
  }
  const number = line === undefined ? Number.NaN : Number(line);
  if (!Number.isInteger(number) || number <= 0) {
    return { file: repoPath };
  }
  return { file: repoPath, line: number };
};

type SourceLocation = { readonly path: string; readonly line: string };

/** The first `path:line` (or tsc's `path(line,col)`) in a line. */
export const findLocation = (text: string): SourceLocation | undefined => {
  for (const token of scanned(text).split(TOKEN_SEPARATORS)) {
    let start = 0;
    while (token[start] === "(") {
      start += 1;
    }
    const match = LOCATION_TOKEN.exec(token.slice(start));
    const line = match?.[2] ?? match?.[3];
    if (match?.[1] !== undefined && line !== undefined) {
      return { path: match[1], line };
    }
  }
  return undefined;
};

/** `path:line:column`, split from the right so a drive colon survives. */
const pathLineColumn = (value: string): SourceLocation | undefined => {
  const parts = value.split(":");
  const line = parts.at(-2);
  const column = parts.at(-1);
  const file = parts.slice(0, -2).join(":");
  if (
    line === undefined ||
    column === undefined ||
    !DIGITS.test(line) ||
    !DIGITS.test(column) ||
    file === "" ||
    file.includes(" ")
  ) {
    return undefined;
  }
  return { path: file, line };
};

const isStackFrame = (text: string): boolean =>
  text.trimStart().startsWith("at ");

/** The location of a stack frame: `at fn (path:1:2)` or `at path:1:2`. */
export const frameLocation = (text: string): SourceLocation | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("at ")) {
    return undefined;
  }
  let inner = trimmed.slice(3);
  if (inner.endsWith(")")) {
    const open = inner.lastIndexOf("(");
    if (open === -1) {
      return undefined;
    }
    inner = inner.slice(open + 1, -1);
  }
  return pathLineColumn(inner);
};

const firstFrame = (lines: readonly string[]): SourceLocation | undefined => {
  for (const text of lines) {
    const frame = frameLocation(text);
    if (
      frame !== undefined &&
      !frame.path.includes("node_modules") &&
      !frame.path.startsWith("bun:") &&
      !frame.path.startsWith("node:")
    ) {
      return frame;
    }
  }
  return undefined;
};

type PlaywrightEntry = {
  readonly project: string;
  readonly path: string;
  readonly line: string;
  readonly title: string;
};

/** A list-reporter failure: `1) [project] › file:1:2 › title ───`. */
export const playwrightEntry = (text: string): PlaywrightEntry | undefined => {
  const head = PLAYWRIGHT_HEAD.exec(text);
  if (!head) {
    return undefined;
  }
  const [where = "", ...titleParts] = text.slice(head[0].length).split(" › ");
  const location = pathLineColumn(where);
  let title = titleParts.join(" › ").trimEnd();
  while (title.endsWith("─")) {
    title = title.slice(0, -1);
  }
  title = title.trimEnd();
  const open = title.lastIndexOf(" (");
  if (
    title.endsWith(")") &&
    open !== -1 &&
    PLAYWRIGHT_DURATION.test(title.slice(open + 2, -1))
  ) {
    title = title.slice(0, open);
  }
  if (location === undefined || title === "") {
    return undefined;
  }
  return { project: head[1] ?? "", ...location, title };
};

/** An oxlint error header: `x rule: message` or `× rule: message`. */
const oxlintMessage = (text: string): string | undefined => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("x ") && !trimmed.startsWith("× ")) {
    return undefined;
  }
  const message = trimmed.slice(2).trim();
  return message === "" ? undefined : message;
};

const cleanDetail = (lines: readonly string[]): string[] =>
  lines
    .map((text) => text.trimEnd())
    .filter(
      (text) =>
        text.trim() !== "" &&
        !text.startsWith("##[") &&
        !/^\s*\^\s*$/u.test(text),
    );

/** Failing bun and Playwright tests, in log order and deduplicated. */
export const testFailures = (rawLines: readonly string[]): TestFailure[] => {
  const lines = logLines(rawLines);
  const failures: TestFailure[] = [];
  // Turbo interleaves packages, so each scope keeps its own pending block.
  const pending = new Map<string, string[]>();
  const currentFile = new Map<string, string>();
  for (const [index, { text, scope }] of lines.entries()) {
    const header = BUN_FILE_HEADER.exec(text);
    if (header?.[1] !== undefined) {
      currentFile.set(scope, header[1]);
      pending.set(scope, []);
      continue;
    }
    const result = BUN_RESULT.exec(text);
    if (result) {
      if (result[1] === "fail") {
        const block = cleanDetail(pending.get(scope) ?? []);
        const frame = firstFrame(block);
        const source = currentFile.get(scope);
        const file = frame?.path ?? source;
        failures.push({
          scope,
          name: result[2] ?? "",
          ...(source === undefined ? {} : { source }),
          ...(file === undefined ? {} : { file: shortPath(file) }),
          ...(frame === undefined ? {} : { line: Number(frame.line) }),
          detail: block.filter((detail) => !isStackFrame(detail)),
        });
      }
      pending.set(scope, []);
      continue;
    }
    if (text.startsWith("# Unhandled error")) {
      const block = cleanDetail(
        lines.slice(index + 1, index + 1 + MAX_TAIL_DETAIL).map((l) => l.text),
      );
      const frame = firstFrame(block);
      failures.push({
        scope,
        name: text.replace(/^#\s*/u, ""),
        ...(frame === undefined
          ? {}
          : { file: shortPath(frame.path), line: Number(frame.line) }),
        detail: block.filter((detail) => !isStackFrame(detail)),
      });
      continue;
    }
    const playwright = playwrightEntry(text);
    if (playwright) {
      const following = lines
        .slice(index + 1, index + 1 + MAX_TAIL_DETAIL * 2)
        .map((l) => l.text);
      const end = following.findIndex(
        (next) => playwrightEntry(next) !== undefined,
      );
      failures.push({
        scope,
        name: `[${playwright.project}] ${playwright.title}`,
        file: shortPath(playwright.path),
        line: Number(playwright.line),
        detail: cleanDetail(end === -1 ? following : following.slice(0, end)),
      });
      continue;
    }
    const block = pending.get(scope);
    if (block === undefined) {
      pending.set(scope, [text]);
    } else {
      block.push(text);
      // Bound memory on huge logs; the error sits close to its result line.
      if (block.length > 200) {
        block.splice(0, block.length - 100);
      }
    }
  }
  // A failure listed again in the run's closing summary has no detail there.
  const best = new Map<string, TestFailure>();
  for (const failure of failures) {
    const key = `${failure.scope}\u0000${failure.name}`;
    const known = best.get(key);
    const hasError = failure.detail.some((text) => ERROR_HEADLINE.test(text));
    const knownHasError = known?.detail.some((text) =>
      ERROR_HEADLINE.test(text),
    );
    if (
      known === undefined ||
      (hasError && !knownHasError) ||
      (hasError === knownHasError &&
        known.detail.length < failure.detail.length)
    ) {
      best.set(key, failure);
    }
  }
  return [...best.values()];
};

/** Failing Bun tests with the file header they were printed under. */
export const failedTests = (rawLines: readonly string[]): FailedTest[] =>
  testFailures(rawLines).flatMap(({ scope, source, name }) =>
    source === undefined ? [] : [{ scope, file: source, name }],
  );

const where = (failure: TestFailure): string => {
  if (failure.file === undefined) {
    return "";
  }
  const line = failure.line === undefined ? "" : `:${failure.line}`;
  return ` (${failure.file}${line})`;
};

// The first added line of an expectation diff (`+   "value",`).
const DIFF_ADDED = /^\+ {2,}\S/u;

const headline = (failure: TestFailure): string => {
  const error =
    failure.detail.find((text) => ERROR_HEADLINE.test(text))?.trim() ??
    failure.detail.at(0)?.trim() ??
    "";
  const index = failure.detail.findIndex((text) => text.trim() === error);
  const continuation = failure.detail.at(index + 1)?.trim();
  const reason =
    error.endsWith(":") && continuation ? `${error} ${continuation}` : error;
  const added = failure.detail.find((text) => DIFF_ADDED.test(text));
  return added === undefined ? reason : `${reason} | ${added.slice(1).trim()}`;
};

const testFailureLine = (failure: TestFailure): FailureLine => {
  const prefix = failure.scope === "" ? "" : `${failure.scope}: `;
  const reason = headline(failure);
  const title = `${prefix}(fail) ${failure.name}${where(failure)}`;
  const message = `${title}${reason === "" ? "" : ` -- ${reason}`}`;
  return {
    message: truncate(
      message.length > MAX_LINE_WIDTH && reason !== ""
        ? `${prefix}(fail) ${reason} -- ${failure.name}${where(failure)}`
        : message,
    ),
    ...located(failure.file, failure.line?.toString()),
  };
};

const tscLines = (lines: readonly LogLine[]): FailureLine[] =>
  lines.flatMap(({ text, scope }) => {
    const match = TSC.exec(withoutErrorCommand(text));
    if (!match) {
      return [];
    }
    const file = match[1] ?? "";
    const line = match[2] ?? match[3];
    const prefix = scope === "" ? "" : `${scope}: `;
    return [
      {
        message: truncate(
          `${prefix}${shortPath(file)}:${line ?? "?"} ${match[4] ?? ""}: ${match[5] ?? ""}`,
        ),
        ...located(file, line),
      },
    ];
  });

const oxlintLines = (lines: readonly LogLine[]): FailureLine[] =>
  lines.flatMap(({ text, scope }, index) => {
    const diagnostic = oxlintMessage(text);
    if (diagnostic === undefined) {
      return [];
    }
    for (const next of lines.slice(index + 1, index + 4)) {
      const location = OXLINT_LOCATION.exec(next.text);
      if (location) {
        const prefix = scope === "" ? "" : `${scope}: `;
        return [
          {
            message: truncate(
              `${prefix}${shortPath(location[1] ?? "")}:${location[2] ?? "?"} ${diagnostic}`,
            ),
            ...located(location[1], location[2]),
          },
        ];
      }
    }
    return [];
  });

/** A compiler-style diagnostic: the line opens with `path:line: `. */
const opensWithLocation = (text: string, location: SourceLocation): boolean =>
  text.startsWith(`${location.path}:${location.line}: `);

const genericLines = (lines: readonly LogLine[]): FailureLine[] =>
  lines.flatMap(({ text, scope }) => {
    if (BUN_RESULT.test(text) || text.startsWith("##[")) {
      return [];
    }
    const location = findLocation(text);
    if (
      location === undefined ||
      !(ERRORISH.test(text) || opensWithLocation(text, location))
    ) {
      return [];
    }
    const prefix = scope === "" ? "" : `${scope}: `;
    return [
      {
        message: truncate(`${prefix}${text}`),
        ...located(location.path, location.line),
      },
    ];
  });

const ERROR_COMMAND = "##[error]";
// Typed infrastructure annotations: installer stalls and signals, and an E2E
// stack whose image pulls were rate limited.
const INSTALL_INFRA_FAILURE =
  /^kind=infra\s+class=(?:install-(?:stall|signal)|e2e-stack-rate-limited)\b/u;
const GENERIC_PROCESS_EXIT =
  /^(?:Error:\s*)?Process completed with exit code \d+\.?$/u;
// The installer prints this status after its typed signal/stall annotation.
const INSTALL_SIGNAL_EXIT =
  /^Install finished; exit [1-9]\d*; signal SIG(?:KILL|TERM|INT)(?:;.*)?$/u;

// scripts/retry.sh: per-attempt lines and the final summary command. The
// summary restates the wrapped command; the cause is the output above it.
const RETRY_ATTEMPT_PREFIX = "retry.sh: attempt ";
const RETRY_SUMMARY = /^ failed after \d+ attempts \(exit \d+\)$/u;

const isRetrySummary = (text: string): boolean => {
  const marker = text.lastIndexOf(" failed after ");
  return marker !== -1 && RETRY_SUMMARY.test(text.slice(marker));
};

const isNoise = (text: string): boolean =>
  text.trim() === "" ||
  text.startsWith(RETRY_ATTEMPT_PREFIX) ||
  // Shell test harnesses report passing cases as `  PASS  name`.
  text.trimStart().startsWith("PASS ") ||
  (text.startsWith("##[") && !text.startsWith(ERROR_COMMAND)) ||
  BUN_RESULT.test(text) ||
  /^[-=─_*#\s]+$/u.test(text);

/**
 * The step's closing lines: a guard prints its verdict last, so the cause
 * sits just above the exit. They start at the step's first error command in
 * that window, else at the first line that names a problem. Error commands
 * earlier in the step (negative-test fixtures) are never reached.
 */
const closingLines = (lines: readonly LogLine[]): FailureLine[] => {
  const window = lines
    .filter(({ text }) => !isNoise(text))
    .slice(-TAIL_WINDOW)
    .map(({ text, scope, annotation }) => {
      if (!text.startsWith(ERROR_COMMAND) && annotation !== "error") {
        return { text, scope, command: false };
      }
      // An error command anchors only with its own message: an empty one
      // (a runtime echoing a stack) or a retry summary does not.
      const message = withoutErrorCommand(text);
      const anchors =
        message.trim() !== "" &&
        !isStackFrame(message) &&
        !isRetrySummary(message);
      return { text: message, scope, command: anchors };
    });
  const command = window.findIndex((line) => line.command);
  const anchor =
    command === -1
      ? window.findIndex(({ text }) => ANCHOR.test(text))
      : command;
  return window
    .slice(anchor === -1 ? -MAX_LINES_PER_STEP : anchor)
    .map(({ text, scope }) => {
      const location = findLocation(text);
      const prefix = scope === "" ? "" : `${scope}: `;
      return {
        message: truncate(`${prefix}${text.trim()}`),
        ...(location === undefined
          ? {}
          : located(location.path, location.line)),
      };
    });
};

/**
 * A line's text without a leading error command: tools often print a
 * diagnostic plainly and again as `##[error]…` or `::error …::…`.
 */
export const withoutErrorCommand = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("##[error]")) {
    return trimmed.slice("##[error]".length).trim();
  }
  if (trimmed.startsWith("::error")) {
    const end = trimmed.indexOf("::", 2);
    return end === -1 ? trimmed : trimmed.slice(end + 2).trim();
  }
  return trimmed;
};

/**
 * One line per distinct message, compared without error-command prefixes
 * and surrounding whitespace. A copy with a source location wins.
 */
export const dedupe = (lines: readonly FailureLine[]): FailureLine[] => {
  const kept = new Map<string, FailureLine>();
  for (const line of lines) {
    const message = withoutErrorCommand(line.message);
    const known = kept.get(message);
    if (
      known === undefined ||
      (known.file === undefined && line.file !== undefined)
    ) {
      kept.set(message, { ...line, message });
    }
  }
  return [...kept.values()];
};

/**
 * The first actionable lines of one failed step. The most specific format
 * found wins, so a test failure is never crowded out by fixture output.
 */
export const failureLines = (
  rawLines: readonly string[],
  limit = MAX_LINES_PER_STEP,
): FailureLine[] => {
  const lines = logLines(rawLines).filter(
    ({ text }) => !EXIT_MARKER.test(text),
  );
  const installFailures = dedupe(
    lines.flatMap(({ text }) => {
      const message = withoutErrorCommand(text);
      return INSTALL_INFRA_FAILURE.test(message)
        ? [{ message: truncate(message) }]
        : [];
    }),
  );
  const extractors = [
    () =>
      testFailures(rawLines).flatMap((failure) => {
        const index = failure.detail.findIndex((text) =>
          ERROR_HEADLINE.test(text),
        );
        const error = failure.detail.at(index);
        const detail =
          index !== -1 && error?.trimEnd().endsWith(":")
            ? failure.detail.slice(index + 2, index + MAX_LINES_PER_STEP)
            : [];
        return [
          testFailureLine(failure),
          ...detail.map((message) => ({
            message: truncate(message),
            ...located(failure.file, failure.line?.toString()),
          })),
        ];
      }),
    () => tscLines(lines),
    () => oxlintLines(lines),
    () => {
      const markers = lines.flatMap(({ text, scope, annotation }, index) => {
        const trimmed = text.trimStart();
        if (
          annotation === "continuation" ||
          (annotation !== "error" &&
            !/^(?:error:|::error(?: |::)|##\[error\])/iu.test(trimmed)) ||
          isRetrySummary(trimmed)
        ) {
          return [];
        }
        const message = withoutErrorCommand(trimmed);
        if (
          (message === "" && annotation !== "error") ||
          isStackFrame(message) ||
          /^error: script ".*" exited with code \d+$/u.test(message)
        ) {
          return [];
        }
        const block = [{ text: message, scope }];
        if (annotation === "error") {
          for (const next of lines.slice(
            index + 1,
            index + MAX_LINES_PER_STEP,
          )) {
            if (next.annotation !== "continuation") {
              break;
            }
            block.push(next);
          }
        }
        return block.flatMap(({ text: detail, scope: detailScope }) => {
          if (detail.trim() === "" || isStackFrame(detail)) {
            return [];
          }
          const location = findLocation(detail);
          return [
            {
              message: truncate(
                `${detailScope === "" ? "" : `${detailScope}: `}${detail}`,
              ),
              ...(location === undefined
                ? {}
                : located(location.path, location.line)),
            },
          ];
        });
      });
      const generic = genericLines(lines);
      const window = lines.slice(-TAIL_WINDOW);
      const terminal = window.findLastIndex(({ text, annotation }) => {
        const message = withoutErrorCommand(text);
        return (
          annotation !== "continuation" &&
          !isRetrySummary(message) &&
          !/^error: script ".*" exited with code \d+$/u.test(message) &&
          !isStackFrame(message) &&
          (annotation === "error" || ANCHOR.test(message))
        );
      });
      if (terminal !== -1 && (markers.length > 0 || generic.length === 0)) {
        return [
          ...closingLines(window.slice(terminal)),
          ...generic,
          ...markers,
        ];
      }
      if (generic.length > 0) {
        return [...generic, ...markers];
      }
      return markers.length === 0 ? [] : [...markers, ...closingLines(lines)];
    },
    () => closingLines(lines),
  ];
  for (const extract of extractors) {
    const found = dedupe(extract());
    if (found.length > 0) {
      if (installFailures.length === 0) {
        return found.slice(0, limit);
      }
      // Specific compiler/test extraction must retain the installer evidence too.
      // Reserve room for both, keeping code evidence first if the limit is small.
      const independent = found.filter(
        ({ message }) =>
          !INSTALL_INFRA_FAILURE.test(message) &&
          !GENERIC_PROCESS_EXIT.test(message) &&
          !INSTALL_SIGNAL_EXIT.test(message),
      );
      return dedupe([
        ...independent.slice(0, Math.max(1, limit - installFailures.length)),
        ...installFailures,
      ]).slice(0, limit);
    }
  }
  return [];
};

export const classify = (
  step: string,
  lines: readonly FailureLine[],
): FailureKind => {
  const name = step.toLowerCase();
  const text = lines.map(({ message }) => message).join("\n");
  const substantive = lines
    .flatMap(({ message }) => message.split(/\r?\n/u))
    .map((message) => withoutErrorCommand(message).trim())
    .filter(
      (message) =>
        message !== "" &&
        !GENERIC_PROCESS_EXIT.test(message) &&
        !INSTALL_SIGNAL_EXIT.test(message),
    );
  if (
    substantive.length > 0 &&
    substantive.every((message) => INSTALL_INFRA_FAILURE.test(message))
  ) {
    return "infra";
  }
  if (/ratchet/u.test(name) || /\bratchet\b/iu.test(text)) {
    return "ratchet";
  }
  if (
    /typecheck|tsc|tsgo|\btypes?\b/u.test(name) ||
    /\bTS\d{4,5}\b/u.test(text)
  ) {
    return "typecheck";
  }
  if (
    /\(fail\)|^\[[\w-]+\] /mu.test(text) ||
    /\btests?\b|\bspecs?\b|e2e|playwright|smoke/u.test(name)
  ) {
    return "test";
  }
  if (
    /lint|format|fmt|oxlint|biome|prettier|stylelint/u.test(name) ||
    LINT_RULE.test(text)
  ) {
    return "lint";
  }
  if (/build|bundle|image|docker|compile|package/u.test(name)) {
    return "build";
  }
  if (
    /check|guard|policy|verify|validate|drift|audit|ensure|require|enforce/u.test(
      name,
    )
  ) {
    return "policy";
  }
  return "other";
};

// ---------------------------------------------------------------------------
// Job logs

export type LogSegment = {
  /** Epoch milliseconds of the step's first line, when timestamped. */
  readonly startedAt: number | undefined;
  readonly lines: readonly string[];
  /** The runner recorded a non-zero exit for this step. */
  readonly failed: boolean;
};

const timestampOf = (raw: string): number | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z/u.exec(
    raw,
  );
  if (!match) {
    return undefined;
  }
  const millis = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(`${match[1] ?? ""}.${millis}Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Splits a job log into steps. Each step opens with a `##[group]Run` block
 * (its command and environment), which is dropped from the step's lines.
 */
export const splitSteps = (log: string): LogSegment[] => {
  const segments: { startedAt: number | undefined; lines: string[] }[] = [];
  let current: { startedAt: number | undefined; lines: string[] } = {
    startedAt: undefined,
    lines: [],
  };
  let inHeader = false;
  for (const raw of log.split("\n")) {
    const text = stripAnsi(scanned(raw).replace(TIMESTAMP, ""));
    if (text.startsWith(GROUP_RUN)) {
      segments.push(current);
      current = { startedAt: timestampOf(raw), lines: [] };
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (text.startsWith("##[endgroup]")) {
        inHeader = false;
      }
      continue;
    }
    if (text.startsWith(BACKGROUND_WAIT)) {
      // The runner's wait for background steps is a step of its own.
      segments.push(current);
      current = { startedAt: timestampOf(raw), lines: [] };
    } else if (text.startsWith(POST_JOB)) {
      // Post-job cleanup belongs to no step.
      segments.push(current);
      current = { startedAt: undefined, lines: [] };
    }
    current.lines.push(raw);
    if (EXIT_MARKER.test(text)) {
      // The runner's exit line closes the step: later lines (post-job
      // cleanup) belong to no failed step.
      segments.push(current);
      current = { startedAt: undefined, lines: [] };
    }
  }
  segments.push(current);
  return segments
    .filter(({ lines }) => lines.length > 0)
    .map((segment) => ({
      ...segment,
      failed: segment.lines.some((raw) => {
        const text = stripAnsi(scanned(raw).replace(TIMESTAMP, ""));
        // A background step reported as failed fails the wait step.
        return EXIT_MARKER.test(text) || text.trimEnd().endsWith(": Failed");
      }),
    }));
};

export type ApiStep = {
  readonly name: string;
  readonly number: number;
  readonly conclusion: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
};

export type ApiJob = {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly html_url?: string | null;
  readonly steps?: readonly ApiStep[] | null;
};

const SLACK_MS = 1000;

/** The log segment of one failed step: by time, then by failure order. */
export const segmentForStep = (
  step: ApiStep,
  unused: readonly LogSegment[],
): LogSegment | undefined => {
  const started = Date.parse(step.started_at ?? "");
  const completed = Date.parse(step.completed_at ?? "");
  if (!Number.isNaN(started) && !Number.isNaN(completed)) {
    // Only unused segments: one log segment explains one failed step.
    const candidates = unused.filter(
      ({ startedAt }) =>
        startedAt !== undefined &&
        startedAt >= started - SLACK_MS &&
        startedAt <= completed + SLACK_MS,
    );
    // A failed segment wins; among equals, the one starting closest to the
    // step's own start (an adjacent short step can share the window).
    const failed = candidates.filter((segment) => segment.failed);
    const pool = failed.length > 0 ? failed : candidates;
    let chosen: LogSegment | undefined;
    for (const segment of pool) {
      const distance = Math.abs((segment.startedAt ?? 0) - started);
      if (
        chosen === undefined ||
        distance < Math.abs((chosen.startedAt ?? 0) - started)
      ) {
        chosen = segment;
      }
    }
    if (chosen !== undefined) {
      return chosen;
    }
  }
  return unused.find(({ failed }) => failed);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStep = (value: unknown): ApiStep | undefined => {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  const text = (key: string): string | null => {
    const field = value[key];
    return typeof field === "string" ? field : null;
  };
  return {
    name: value["name"],
    number: typeof value["number"] === "number" ? value["number"] : 0,
    conclusion: text("conclusion"),
    started_at: text("started_at"),
    completed_at: text("completed_at"),
  };
};

/** Jobs from a single response, a page list, or `--slurp` output. */
export const parseJobs = (value: unknown): ApiJob[] => {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page): ApiJob[] => {
    const jobs = isRecord(page) ? page["jobs"] : undefined;
    if (!Array.isArray(jobs)) {
      return [];
    }
    return jobs.flatMap((job): ApiJob[] => {
      if (
        !isRecord(job) ||
        typeof job["id"] !== "number" ||
        typeof job["name"] !== "string"
      ) {
        return [];
      }
      const steps = Array.isArray(job["steps"])
        ? job["steps"].flatMap((step) => parseStep(step) ?? [])
        : [];
      return [
        {
          id: job["id"],
          name: job["name"],
          conclusion:
            typeof job["conclusion"] === "string" ? job["conclusion"] : null,
          html_url:
            typeof job["html_url"] === "string" ? job["html_url"] : null,
          steps,
        },
      ];
    });
  });
};

type DigestOptions = {
  readonly jobs: readonly ApiJob[];
  /** The job's log, or undefined when it could not be fetched. */
  readonly logFor: (job: ApiJob) => string | undefined;
};

/**
 * Jobs the result gate fails on: failed or timed-out jobs, cancelled jobs
 * that contain a failed step (a cancellation can mask a failure), and the
 * still-running job with a failed step: the gate running this digest, so a
 * gate that fails before it evaluates any job still names its own step.
 */
export const isFailedJob = (job: ApiJob): boolean =>
  job.conclusion === "failure" ||
  job.conclusion === "timed_out" ||
  ((job.conclusion === "cancelled" || job.conclusion === null) &&
    (job.steps ?? []).some(({ conclusion }) => conclusion === "failure"));

export const buildDigest = ({ jobs, logFor }: DigestOptions): FailureRecord[] =>
  jobs.filter(isFailedJob).flatMap((job) => {
    const log = logFor(job);
    const segments = log === undefined ? [] : splitSteps(log);
    const unused = [...segments];
    const failedSteps = (job.steps ?? []).filter(
      ({ conclusion }) => conclusion === "failure",
    );
    const steps =
      failedSteps.length > 0
        ? failedSteps
        : [{ name: "(job)", number: 0, conclusion: "failure" }];
    return steps.flatMap((step): FailureRecord[] => {
      const segment =
        step.name === "(job)"
          ? (segments.findLast(({ failed }) => failed) ?? segments.at(-1))
          : segmentForStep(step, unused);
      const position = segment === undefined ? -1 : unused.indexOf(segment);
      if (position !== -1) {
        unused.splice(position, 1);
      }
      const pooled =
        segment === undefined ? [] : pooledFailureRecords(segment.lines);
      if (pooled.length > 0) {
        return pooled.map(({ name, cause, groupLines }) => {
          const own = BARE_EXIT_CAUSE.test(cause)
            ? failureLines(groupLines)
            : [];
          const lines = own.length > 0 ? own : [{ message: cause }];
          return {
            job: job.name,
            step: name,
            kind: classify(name, lines),
            url: job.html_url ?? "",
            lines,
            tests: failedTests(groupLines),
          };
        });
      }
      const found = segment === undefined ? [] : failureLines(segment.lines);
      const link = job.html_url ? ` See ${job.html_url}` : "";
      const missing =
        log === undefined
          ? `Log of job "${job.name}" was unavailable to the digest.${link}`
          : `No log output found for this step.${link}`;
      const lines = found.length > 0 ? found : [{ message: missing }];
      return [
        {
          job: job.name,
          step: step.name,
          kind: classify(step.name, lines),
          url: job.html_url ?? "",
          lines,
          tests: segment === undefined ? [] : failedTests(segment.lines),
        },
      ];
    });
  });

// ---------------------------------------------------------------------------
// Output

const escapeData = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeProperty = (value: string): string =>
  escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** `::error` workflow commands, capped at GitHub's per-step limit. */
export const annotations = (
  records: readonly FailureRecord[],
  max = MAX_ANNOTATIONS,
): string[] => {
  const shown = records.length > max ? records.slice(0, max - 1) : records;
  const commands = shown.map((record) => {
    const anchor = record.lines.find(({ file }) => file !== undefined);
    const properties = [
      ...(anchor?.file === undefined
        ? []
        : [`file=${escapeProperty(anchor.file)}`]),
      ...(anchor?.line === undefined ? [] : [`line=${anchor.line}`]),
      `title=${escapeProperty(`${record.job} / ${record.step} [${record.kind}]`)}`,
    ];
    const text = record.lines.map(({ message }) => message).join("\n");
    return `::error ${properties.join(",")}::${escapeData(text)}`;
  });
  if (records.length > max) {
    const rest = records.slice(max - 1);
    commands.push(
      `::error title=${escapeProperty(`${rest.length} more failed steps`)}::${escapeData(
        rest
          .map((record) => `${record.job} / ${record.step} [${record.kind}]`)
          .join("\n"),
      )}`,
    );
  }
  return commands;
};

const fence = (value: string): string => value.replaceAll("```", "'''");

const MARKDOWN_SPECIAL = /[\\`*_[\]<>|#]/gu;

/** Job and step names render literally, never as Markdown. */
export const escapeMarkdown = (value: string): string =>
  value.replaceAll(MARKDOWN_SPECIAL, "\\$&");

export const summaryMarkdown = (records: readonly FailureRecord[]): string => {
  if (records.length === 0) {
    return "### Failure digest\n\nNo failed step in this run's jobs.\n";
  }
  const sections = records.map((record) => {
    const lines = record.lines.map(({ message }) => fence(message)).join("\n");
    const link = record.url === "" ? "" : ` ([log](${record.url}))`;
    return `**${escapeMarkdown(record.job)} / ${escapeMarkdown(record.step)}** \`${record.kind}\`${link}\n\n\`\`\`text\n${lines}\n\`\`\`\n`;
  });
  return `### Failure digest\n\n${sections.join("\n")}`;
};

/**
 * The runner reads a workflow command from any output line that starts with
 * `::` after leading whitespace, so echoed log text is prefixed to stay inert.
 */
export const inert = (line: string): string => {
  const trimmed = line.trimStart();
  return trimmed.startsWith("::") || trimmed.startsWith("##[")
    ? `| ${line}`
    : line;
};

/** The failures of a test run, printed last so the log ends with them. */
export const renderTail = (rawLines: readonly string[]): string => {
  const failures = testFailures(rawLines);
  if (failures.length === 0) {
    const lines = failureLines(rawLines).filter(({ message }) =>
      ANCHOR.test(message),
    );
    if (lines.length === 0) {
      return "";
    }
    return [
      "---- failure digest ----",
      ...lines.map(({ message }) => inert(message)),
      "----",
    ].join("\n");
  }
  const shown = failures.slice(0, MAX_TAIL_TESTS);
  const blocks = shown.flatMap((failure) => {
    const prefix = failure.scope === "" ? "" : `${failure.scope}: `;
    return [
      inert(`${prefix}(fail) ${failure.name}${where(failure)}`),
      ...failure.detail
        .slice(0, MAX_TAIL_DETAIL)
        .map((text) => inert(`    ${truncate(text, MAX_LINE_WIDTH * 2)}`)),
    ];
  });
  return [
    `---- failing tests (${shown.length} of ${failures.length}) ----`,
    ...blocks,
    "----",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// CLI

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const USAGE =
  "Usage: bun scripts/ci-failure-digest.ts digest --jobs <jobs.json> --logs <dir> --json <out.json> [--summary <file>]\n" +
  "       bun scripts/ci-failure-digest.ts tail <test-output.log>";

const main = (args: readonly string[]): number => {
  const [command, ...rest] = args;
  if (command === "tail" && rest.length === 1 && rest[0] !== undefined) {
    if (!existsSync(rest[0])) {
      return 0;
    }
    const tail = renderTail(readFileSync(rest[0], "utf-8").split("\n"));
    if (tail !== "") {
      process.stdout.write(`\n${tail}\n`);
    }
    return 0;
  }
  const jobsFile = flagValue(rest, "--jobs");
  const logsDirectory = flagValue(rest, "--logs");
  const jsonFile = flagValue(rest, "--json");
  if (
    command !== "digest" ||
    jobsFile === undefined ||
    logsDirectory === undefined ||
    jsonFile === undefined
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const jobs = parseJobs(JSON.parse(readFileSync(jobsFile, "utf-8")));
  const records = buildDigest({
    jobs,
    logFor: ({ id }) => {
      const file = path.join(logsDirectory, `${id}.log`);
      return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
    },
  });
  writeFileSync(jsonFile, `${JSON.stringify(digestFile(records), null, 2)}\n`);
  const summary = flagValue(rest, "--summary");
  if (summary !== undefined) {
    appendFileSync(summary, summaryMarkdown(records));
  }
  for (const annotation of annotations(records)) {
    process.stdout.write(`${annotation}\n`);
  }
  return 0;
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
