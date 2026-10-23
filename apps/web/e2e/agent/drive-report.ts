// Pure parts of the agent driver (drive.ts): argument parsing, measurement
// aggregation and the Markdown report. Kept free of Playwright so the unit
// suite covers them without a browser.

import type { NetworkCapture } from "../helpers/network";

const DRIVE_COMMANDS = ["snap", "run", "measure"] as const;
type DriveCommand = (typeof DRIVE_COMMANDS)[number];

const COLOR_SCHEMES = ["light", "dark"] as const;
type ColorScheme = (typeof COLOR_SCHEMES)[number];

type Viewport = { height: number; width: number };

export const DEFAULT_VIEWPORT: Viewport = { height: 900, width: 1440 };
const DEFAULT_SAMPLES = 3;
const MAX_SAMPLES = 20;

export type DriveOptions = {
  colorScheme: ColorScheme;
  compare: string | undefined;
  fullPage: boolean;
  samples: number;
  save: string | undefined;
  viewport: Viewport;
  waitFor: string | undefined;
};

type DriveArgs = {
  command: DriveCommand;
  options: DriveOptions;
  targets: string[];
};

type DriveArgsResult =
  | { type: "ok"; args: DriveArgs }
  | { type: "error"; message: string };

const DRIVE_USAGE = `Usage:
  agent:drive snap <path>... [--wait-for <selector>] [--viewport 1440x900]
                             [--color-scheme light|dark] [--full-page]
  agent:drive run <script.ts> [--viewport ...] [--color-scheme ...]
  agent:drive measure <path> [--samples 3] [--save <label>]
                             [--compare <label>]

Paths are app paths such as /workspaces or /chat/new. A run script
default-exports async ({ page, snap, webUrl, apiUrl }) => {}; call
snap("label") to add a screenshot to the report.`;

const LABEL_PATTERN = /^[\w.-]+$/u;
const VIEWPORT_PATTERN = /^(?<width>\d{3,4})x(?<height>\d{3,4})$/u;

const isDriveCommand = (value: string | undefined): value is DriveCommand =>
  DRIVE_COMMANDS.some((command) => command === value);

const isColorScheme = (value: string): value is ColorScheme =>
  COLOR_SCHEMES.some((scheme) => scheme === value);

const VALUE_FLAGS = [
  "--color-scheme",
  "--compare",
  "--samples",
  "--save",
  "--viewport",
  "--wait-for",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const MEASURE_ONLY_FLAGS = [
  "--compare",
  "--samples",
  "--save",
] as const satisfies readonly ValueFlag[];

const isValueFlag = (value: string): value is ValueFlag =>
  VALUE_FLAGS.some((flag) => flag === value);

const error = (message: string): DriveArgsResult => ({
  type: "error",
  message: `${message}\n\n${DRIVE_USAGE}`,
});

export const parseDriveArgs = (argv: readonly string[]): DriveArgsResult => {
  const [command, ...rest] = argv;
  if (!isDriveCommand(command)) {
    return error(`Unknown command: ${command ?? "(none)"}`);
  }

  const values = new Map<ValueFlag, string>();
  const targets: string[] = [];
  let fullPage = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    if (arg === "--full-page") {
      fullPage = true;
      continue;
    }
    if (isValueFlag(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return error(`${arg} requires a value`);
      }
      values.set(arg, value);
      index++;
      continue;
    }
    if (arg.startsWith("--")) {
      return error(`Unknown flag: ${arg}`);
    }
    targets.push(arg);
  }

  if (targets.length === 0) {
    return error(`${command} needs at least one target`);
  }
  if (command !== "snap" && targets.length > 1) {
    return error(`${command} takes exactly one target`);
  }
  if (command !== "run" && targets.some((target) => !target.startsWith("/"))) {
    return error("Paths must start with /");
  }

  const viewportValue = values.get("--viewport");
  const viewportMatch =
    viewportValue === undefined
      ? undefined
      : VIEWPORT_PATTERN.exec(viewportValue);
  if (viewportValue !== undefined && !viewportMatch) {
    return error("--viewport must look like 1440x900");
  }
  const viewport = viewportMatch
    ? {
        height: Number(viewportMatch.groups?.["height"]),
        width: Number(viewportMatch.groups?.["width"]),
      }
    : DEFAULT_VIEWPORT;

  const colorScheme = values.get("--color-scheme") ?? "light";
  if (!isColorScheme(colorScheme)) {
    return error("--color-scheme must be light or dark");
  }

  const samples = Number(values.get("--samples") ?? DEFAULT_SAMPLES);
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
    return error(`--samples must be an integer from 1 to ${MAX_SAMPLES}`);
  }

  for (const flag of ["--save", "--compare"] as const) {
    const label = values.get(flag);
    if (label !== undefined && !LABEL_PATTERN.test(label)) {
      return error(`${flag} takes a file-safe label such as before-fix`);
    }
  }

  if (
    command !== "measure" &&
    MEASURE_ONLY_FLAGS.some((flag) => values.has(flag))
  ) {
    return error(`${MEASURE_ONLY_FLAGS.join(", ")} only apply to measure`);
  }

  return {
    type: "ok",
    args: {
      command,
      options: {
        colorScheme,
        compare: values.get("--compare"),
        fullPage,
        samples,
        save: values.get("--save"),
        viewport,
        waitFor: values.get("--wait-for"),
      },
      targets,
    },
  };
};

// --- page findings ---------------------------------------------------------

export type PageFindings = {
  // Console errors and uncaught exceptions, as the e2e error collector
  // reports them (known transport noise already filtered).
  browserErrors: string[];
  // API responses with a 4xx/5xx status, as "METHOD /path -> status".
  failedRequests: string[];
  // The page landed somewhere other than where it was sent (sign-in, error
  // boundary): the screenshot shows the wrong thing.
  navigationProblems: string[];
};

export const hasBlockingFindings = ({
  browserErrors,
  failedRequests,
  navigationProblems,
}: PageFindings) =>
  browserErrors.length > 0 ||
  navigationProblems.length > 0 ||
  failedRequests.some((entry) => /-> 5\d\d$/u.test(entry));

// --- measurement -----------------------------------------------------------

export type MeasureSample = {
  // Navigation start to the first quiet API window, excluding the window.
  settledMs: number;
  domContentLoadedMs: number | null;
  largestContentfulPaintMs: number | null;
  // Page totals over every API response, repeats included.
  apiRequests: number;
  waterfallDepth: number;
  dbQueries: number;
  responseBytes: number;
};

const TIMING_METRICS = [
  "settledMs",
  "domContentLoadedMs",
  "largestContentfulPaintMs",
] as const;
type TimingMetric = (typeof TIMING_METRICS)[number];

type MeasureSummary = {
  path: string;
  samples: number;
  settledMs: number;
  domContentLoadedMs: number | null;
  largestContentfulPaintMs: number | null;
  apiRequests: number;
  waterfallDepth: number;
  dbQueries: number;
  responseKiB: number;
  // Max minus min across samples per timing: the noise floor a comparison
  // must clear before a timing delta means anything.
  spreadMs: Record<TimingMetric, number | null>;
};

// Page totals add up every response; the route baseline's per-endpoint maximum
// would count a repeated call once.
export const pageTotals = ({ requests }: NetworkCapture) => {
  let dbQueries = 0;
  let responseBytes = 0;
  for (const request of requests) {
    dbQueries += request.dbQueries ?? 0;
    responseBytes += request.responseBytes ?? 0;
  }
  return { apiRequests: requests.length, dbQueries, responseBytes };
};

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? upper) + upper) / 2
    : upper;
};

const medianOrNull = (values: readonly (number | null)[]) => {
  const present = values.filter((value) => value !== null);
  return present.length === 0 ? null : Math.round(median(present));
};

const spreadOrNull = (values: readonly (number | null)[]) => {
  const present = values.filter((value) => value !== null);
  return present.length === 0
    ? null
    : Math.round(Math.max(...present) - Math.min(...present));
};

// Timings take the median: dev-server compile jitter is one-sided. Counts
// take the median too, and depth the maximum, matching how the committed
// network baseline treats a deeper reading as the real one.
export const summarizeSamples = (
  path: string,
  samples: readonly MeasureSample[],
): MeasureSummary => ({
  path,
  samples: samples.length,
  settledMs: Math.round(median(samples.map((sample) => sample.settledMs))),
  domContentLoadedMs: medianOrNull(
    samples.map((sample) => sample.domContentLoadedMs),
  ),
  largestContentfulPaintMs: medianOrNull(
    samples.map((sample) => sample.largestContentfulPaintMs),
  ),
  apiRequests: median(samples.map((sample) => sample.apiRequests)),
  waterfallDepth: Math.max(...samples.map((sample) => sample.waterfallDepth)),
  dbQueries: median(samples.map((sample) => sample.dbQueries)),
  responseKiB: Math.round(
    median(samples.map((sample) => sample.responseBytes)) / 1024,
  ),
  spreadMs: {
    settledMs: spreadOrNull(samples.map((sample) => sample.settledMs)),
    domContentLoadedMs: spreadOrNull(
      samples.map((sample) => sample.domContentLoadedMs),
    ),
    largestContentfulPaintMs: spreadOrNull(
      samples.map((sample) => sample.largestContentfulPaintMs),
    ),
  },
});

const METRICS = [
  ...TIMING_METRICS,
  "apiRequests",
  "waterfallDepth",
  "dbQueries",
  "responseKiB",
] as const satisfies readonly (keyof MeasureSummary)[];
type SummaryMetric = (typeof METRICS)[number];

const METRIC_LABELS = {
  settledMs: "Settled (ms)",
  domContentLoadedMs: "DOMContentLoaded (ms)",
  largestContentfulPaintMs: "Largest contentful paint (ms)",
  apiRequests: "API requests",
  waterfallDepth: "Waterfall depth",
  dbQueries: "DB queries",
  responseKiB: "API response size (KiB)",
} as const satisfies Record<SummaryMetric, string>;

const formatValue = (value: number | null) =>
  value === null ? "-" : String(value);

const isTimingMetric = (metric: SummaryMetric): metric is TimingMetric =>
  TIMING_METRICS.some((timing) => timing === metric);

type FormatDeltaOptions = {
  after: number | null;
  before: number | null;
  // Timing deltas within the larger of the two sample spreads are noise.
  noiseMs: number | null;
};

const formatDelta = ({ after, before, noiseMs }: FormatDeltaOptions) => {
  if (before === null || after === null) {
    return "-";
  }
  const delta = after - before;
  if (delta === 0) {
    return "0";
  }
  const sign = delta > 0 ? "+" : "";
  const percent =
    before === 0
      ? ""
      : ` (${sign}${String(Math.round((delta / before) * 100))}%)`;
  const noise =
    noiseMs !== null && Math.abs(delta) <= noiseMs ? ", within noise" : "";
  return `${sign}${String(delta)}${percent}${noise}`;
};

const noiseFor = (
  metric: SummaryMetric,
  summaries: readonly MeasureSummary[],
) => {
  if (!isTimingMetric(metric)) {
    return null;
  }
  const spreads = summaries.map((summary) => summary.spreadMs[metric]);
  return spreads.some((spread) => spread === null)
    ? null
    : Math.max(...spreads.map((spread) => spread ?? 0));
};

export const formatSummaryTable = (
  summary: MeasureSummary,
  previous?: { label: string; summary: MeasureSummary },
) => {
  const rows = previous
    ? [
        `| Metric | ${previous.label} | now | delta |`,
        "| --- | ---: | ---: | ---: |",
        ...METRICS.map(
          (metric) =>
            `| ${METRIC_LABELS[metric]} | ${formatValue(previous.summary[metric])} | ${formatValue(summary[metric])} | ${formatDelta(
              {
                after: summary[metric],
                before: previous.summary[metric],
                noiseMs: noiseFor(metric, [previous.summary, summary]),
              },
            )} |`,
        ),
      ]
    : [
        "| Metric | Value |",
        "| --- | ---: |",
        ...METRICS.map(
          (metric) =>
            `| ${METRIC_LABELS[metric]} | ${formatValue(summary[metric])} |`,
        ),
      ];
  return rows.join("\n");
};

export const isMeasureSummary = (value: unknown): value is MeasureSummary =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  typeof value.path === "string" &&
  "spreadMs" in value &&
  typeof value.spreadMs === "object" &&
  value.spreadMs !== null &&
  METRICS.every(
    (metric) =>
      metric in value &&
      (typeof Reflect.get(value, metric) === "number" ||
        Reflect.get(value, metric) === null),
  );

export const formatFindings = ({
  browserErrors,
  failedRequests,
  navigationProblems,
}: PageFindings) => {
  const sections = [
    ["Navigation problems", navigationProblems],
    ["Browser errors", browserErrors],
    ["Failed API requests", failedRequests],
  ] as const;
  const lines: string[] = [];
  for (const [title, entries] of sections) {
    lines.push(
      entries.length === 0
        ? `- ${title}: none`
        : `- ${title}:\n${entries.map((entry) => `  - ${entry}`).join("\n")}`,
    );
  }
  return lines.join("\n");
};
