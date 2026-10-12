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

export type FailureRecord = {
  readonly job: string;
  readonly step: string;
  readonly kind: FailureKind;
  readonly url: string;
  readonly lines: readonly FailureLine[];
};

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
const TURBO_PREFIX = /^(@[\w.-]+\/[\w.-]+|[\w.-]+):([a-z][\w:-]*): ?/u;
const EXIT_MARKER = /^##\[error\]Process completed with exit code \d+\.?$/u;
const GROUP_RUN = "##[group]Run ";

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

type LogLine = { readonly text: string; readonly scope: string };

const logLine = (raw: string): LogLine => {
  const text = stripAnsi(raw.replace(TIMESTAMP, "")).replace(/\r$/u, "");
  const turbo = TURBO_PREFIX.exec(text);
  return turbo
    ? { text: text.slice(turbo[0].length), scope: turbo[1] ?? "" }
    : { text, scope: "" };
};

// ---------------------------------------------------------------------------
// Failure extraction

const LOCATION =
  /((?:[A-Za-z]:)?[\w@.~/\\-]*[\w@.-]+\.(?:[cm]?[jt]sx?|rs|py|sh|ya?ml|json|toml|css|md|sql|go))(?::(\d+)(?::\d+)?|\((\d+),\d+\))/u;
const TSC = /^(.+?)(?:\((\d+),\d+\)|:(\d+):\d+)(?::| -) error (TS\d+): (.*)$/u;
const BUN_RESULT = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$/u;
const BUN_FILE_HEADER = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/u;
const STACK_FRAME = /^\s*at .*?\(?((?:[A-Za-z]:)?[^\s():]+):(\d+):\d+\)?$/u;
const ERROR_HEADLINE =
  /^\s*(?:error:|(?:\w*Error|AssertionError)(?:\s*\[\w+\])?:|Expected|Received|expect\()/u;
const PLAYWRIGHT_ENTRY =
  /^\s*\d+\) \[([^\]]+)\] › (.+?):(\d+):\d+ › (.+?)\s*─*$/u;
const PLAYWRIGHT_FAILED_LINE =
  /^\s*[✘x]\s+\d+ \[([^\]]+)\] › (.+?):(\d+):\d+ › (.+?)(?: \([\d.]+m?s\))?$/u;
const OXLINT_DIAGNOSTIC = /^\s*[x×]\s+(.+)$/u;
const OXLINT_LOCATION = /^\s*[,╭]─?-?\[(.+?):(\d+):\d+\]/u;
const ERRORISH = /\b(?:error|errors|failed|failure|fail)\b/iu;
const ANCHOR =
  /\b(?:error|errors|fail|failed|failure|invalid|violat\w*|regress\w*|mismatch\w*|missing|not allowed|forbidden|must|expected)\b/iu;

/** One failing test with the lines that explain it. */
export type TestFailure = {
  readonly scope: string;
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
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

const firstFrame = (
  lines: readonly string[],
): { path: string; line: string } | undefined => {
  for (const text of lines) {
    const frame = STACK_FRAME.exec(text);
    if (
      frame?.[1] !== undefined &&
      frame[2] !== undefined &&
      !frame[1].includes("node_modules") &&
      !frame[1].startsWith("bun:") &&
      !frame[1].startsWith("node:")
    ) {
      return { path: frame[1], line: frame[2] };
    }
  }
  return undefined;
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
  const lines = rawLines.map(logLine);
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
        const file = frame?.path ?? currentFile.get(scope);
        failures.push({
          scope,
          name: result[2] ?? "",
          ...(file === undefined ? {} : { file: shortPath(file) }),
          ...(frame === undefined ? {} : { line: Number(frame.line) }),
          detail: block.filter((detail) => !STACK_FRAME.test(detail)),
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
        detail: block.filter((detail) => !STACK_FRAME.test(detail)),
      });
      continue;
    }
    const playwright =
      PLAYWRIGHT_ENTRY.exec(text) ?? PLAYWRIGHT_FAILED_LINE.exec(text);
    if (playwright) {
      const following = lines
        .slice(index + 1, index + 1 + MAX_TAIL_DETAIL * 2)
        .map((l) => l.text);
      const end = following.findIndex(
        (next) =>
          PLAYWRIGHT_ENTRY.test(next) || PLAYWRIGHT_FAILED_LINE.test(next),
      );
      failures.push({
        scope,
        name: `[${playwright[1] ?? ""}] ${playwright[4] ?? ""}`,
        file: shortPath(playwright[2] ?? ""),
        line: Number(playwright[3]),
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
    if (known === undefined || known.detail.length < failure.detail.length) {
      best.set(key, failure);
    }
  }
  return [...best.values()];
};

const where = (failure: TestFailure): string => {
  if (failure.file === undefined) {
    return "";
  }
  const line = failure.line === undefined ? "" : `:${failure.line}`;
  return ` (${failure.file}${line})`;
};

const headline = (failure: TestFailure): string =>
  failure.detail.find((text) => ERROR_HEADLINE.test(text))?.trim() ??
  failure.detail.at(0)?.trim() ??
  "";

const testFailureLine = (failure: TestFailure): FailureLine => {
  const prefix = failure.scope === "" ? "" : `${failure.scope}: `;
  const reason = headline(failure);
  return {
    message: truncate(
      `${prefix}(fail) ${failure.name}${where(failure)}${reason === "" ? "" : ` -- ${reason}`}`,
    ),
    ...located(failure.file, failure.line?.toString()),
  };
};

const tscLines = (lines: readonly LogLine[]): FailureLine[] =>
  lines.flatMap(({ text, scope }) => {
    const match = TSC.exec(text);
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
    const diagnostic = OXLINT_DIAGNOSTIC.exec(text);
    if (!diagnostic) {
      return [];
    }
    for (const next of lines.slice(index + 1, index + 4)) {
      const location = OXLINT_LOCATION.exec(next.text);
      if (location) {
        const prefix = scope === "" ? "" : `${scope}: `;
        return [
          {
            message: truncate(
              `${prefix}${shortPath(location[1] ?? "")}:${location[2] ?? "?"} ${diagnostic[1] ?? ""}`,
            ),
            ...located(location[1], location[2]),
          },
        ];
      }
    }
    return [];
  });

const genericLines = (lines: readonly LogLine[]): FailureLine[] =>
  lines.flatMap(({ text, scope }) => {
    const location = LOCATION.exec(text);
    if (
      !location ||
      !ERRORISH.test(text) ||
      BUN_RESULT.test(text) ||
      text.startsWith("##[")
    ) {
      return [];
    }
    const prefix = scope === "" ? "" : `${scope}: `;
    return [
      {
        message: truncate(`${prefix}${text}`),
        ...located(location[1], location[2] ?? location[3]),
      },
    ];
  });

const ERROR_COMMAND = "##[error]";

const isNoise = (text: string): boolean =>
  text.trim() === "" ||
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
    .map(({ text, scope }) =>
      text.startsWith(ERROR_COMMAND)
        ? { text: text.slice(ERROR_COMMAND.length), scope, command: true }
        : { text, scope, command: false },
    );
  const command = window.findIndex((line) => line.command);
  const anchor =
    command === -1
      ? window.findIndex(({ text }) => ANCHOR.test(text))
      : command;
  return window
    .slice(anchor === -1 ? -MAX_LINES_PER_STEP : anchor)
    .map(({ text, scope }) => {
      const location = LOCATION.exec(text);
      const prefix = scope === "" ? "" : `${scope}: `;
      return {
        message: truncate(`${prefix}${text.trim()}`),
        ...(location ? located(location[1], location[2] ?? location[3]) : {}),
      };
    });
};

export const dedupe = (lines: readonly FailureLine[]): FailureLine[] => {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = `${line.file ?? ""}:${line.line ?? ""}:${line.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * The first actionable lines of one failed step. The most specific format
 * found wins, so a test failure is never crowded out by fixture output.
 */
export const failureLines = (
  rawLines: readonly string[],
  limit = MAX_LINES_PER_STEP,
): FailureLine[] => {
  const lines = rawLines
    .map(logLine)
    .filter(({ text }) => !EXIT_MARKER.test(text));
  const extractors = [
    () => testFailures(rawLines).map(testFailureLine),
    () => tscLines(lines),
    () => oxlintLines(lines),
    () => genericLines(lines),
    () => closingLines(lines),
  ];
  for (const extract of extractors) {
    const found = dedupe(extract());
    if (found.length > 0) {
      return found.slice(0, limit);
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
  if (/lint|format|oxlint|oxfmt|biome|prettier|stylelint/u.test(name)) {
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
    const text = stripAnsi(raw.replace(TIMESTAMP, ""));
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
      failed: segment.lines.some((raw) =>
        EXIT_MARKER.test(stripAnsi(raw.replace(TIMESTAMP, ""))),
      ),
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
  segments: readonly LogSegment[],
  step: ApiStep,
  unused: readonly LogSegment[],
): LogSegment | undefined => {
  const started = Date.parse(step.started_at ?? "");
  const completed = Date.parse(step.completed_at ?? "");
  if (!Number.isNaN(started) && !Number.isNaN(completed)) {
    const candidates = segments.filter(
      ({ startedAt }) =>
        startedAt !== undefined &&
        startedAt >= started - SLACK_MS &&
        startedAt <= completed + SLACK_MS,
    );
    const chosen =
      candidates.findLast(({ failed }) => failed) ?? candidates.at(-1);
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

export const buildDigest = ({ jobs, logFor }: DigestOptions): FailureRecord[] =>
  jobs
    .filter(({ conclusion }) => conclusion === "failure")
    .flatMap((job) => {
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
      return steps.map((step): FailureRecord => {
        const segment =
          step.name === "(job)"
            ? (segments.findLast(({ failed }) => failed) ?? segments.at(-1))
            : segmentForStep(segments, step, unused);
        const position = segment === undefined ? -1 : unused.indexOf(segment);
        if (position !== -1) {
          unused.splice(position, 1);
        }
        const found = segment === undefined ? [] : failureLines(segment.lines);
        const missing =
          log === undefined
            ? "Job log unavailable."
            : "No log output found for this step.";
        const lines = found.length > 0 ? found : [{ message: missing }];
        return {
          job: job.name,
          step: step.name,
          kind: classify(step.name, lines),
          url: job.html_url ?? "",
          lines,
        };
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

export const summaryMarkdown = (records: readonly FailureRecord[]): string => {
  if (records.length === 0) {
    return "### Failure digest\n\nNo failed step in this run's jobs.\n";
  }
  const sections = records.map((record) => {
    const lines = record.lines.map(({ message }) => fence(message)).join("\n");
    const link = record.url === "" ? "" : ` ([log](${record.url}))`;
    return `**${record.job} / ${record.step}** \`${record.kind}\`${link}\n\n\`\`\`text\n${lines}\n\`\`\`\n`;
  });
  return `### Failure digest\n\n${sections.join("\n")}`;
};

/** The failures of a test run, printed last so the log ends with them. */
export const renderTail = (rawLines: readonly string[]): string => {
  const failures = testFailures(rawLines);
  if (failures.length === 0) {
    const lines = failureLines(rawLines).filter(({ message }) =>
      ANCHOR.test(message),
    );
    return lines.length === 0
      ? ""
      : [
          "---- failure digest ----",
          ...lines.map(({ message }) => message),
          "----",
        ].join("\n");
  }
  const shown = failures.slice(0, MAX_TAIL_TESTS);
  const blocks = shown.map((failure) => {
    const prefix = failure.scope === "" ? "" : `${failure.scope}: `;
    return [
      `${prefix}(fail) ${failure.name}${where(failure)}`,
      ...failure.detail
        .slice(0, MAX_TAIL_DETAIL)
        .map((text) => `    ${truncate(text, MAX_LINE_WIDTH * 2)}`),
    ].join("\n");
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
  writeFileSync(
    jsonFile,
    `${JSON.stringify(
      {
        version: 1,
        run_id: process.env["GITHUB_RUN_ID"] ?? null,
        run_attempt: process.env["GITHUB_RUN_ATTEMPT"] ?? null,
        failures: records,
      },
      null,
      2,
    )}\n`,
  );
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
