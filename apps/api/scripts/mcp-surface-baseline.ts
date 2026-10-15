import { panic, Result } from "better-result";
// MCP tool-surface baseline.
//
// Measures what each audience advertises, per part, against a committed
// baseline: the tool count, the UTF-16 length of every part a host may put in
// front of a model (name, title, description, input and output schema,
// annotations, the connect-time instructions), the UTF-8 size of the served
// `tools/list` array, and the largest description, input schema and output
// schema. Every audience in `MCP_MODES` is read from the canonical static
// registry and serialized with its own mode, as `tools/list` serves it. The
// measurement is the unfiltered first-party list, an upper bound for any
// session's first-party tools; the skill and connector tools the gateway adds
// per organization are not part of it.
//
// The file stores one row per (tool, audience) with that tool's own sizes, and
// one instructions length per audience. It stores no totals: the per-audience
// sums, the wire size and the largest entries are derived from the rows when
// the check runs, so changes to different tools rewrite different lines. The
// rows are sorted by tool, then audience, one per line, and every tool's rows
// sit in their own block; `--check` rejects a file in any other shape.
//
// A change that moves a derived total past its tolerance rewrites the
// baseline, so review sees the rows it moved and the pull request argues for
// them. The gate is `src/mcp/registry-quality.test.ts`, which reads the same
// file. Fixed caps are not measurements and stay with their owners: the
// per-tool ceilings in that test, the per-audience instruction ceilings in
// `src/mcp/instructions.ts`.
//
// Modes (from apps/api):
//   bun run mcp:surface-baseline                report parts and views
//   bun run mcp:surface-baseline --write        rewrite the baseline
//   bun run mcp:surface-baseline --check        exit 1 when a row drifted or
//                                               the file is not in its format
//   bun run mcp:surface-baseline --self-test    prove the comparison and the
//                                               format check fire
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { printError } from "@stll/errors";

const BASELINE_REL = "apps/api/mcp-surface-baseline.json";
const BASELINE_PATH = path.resolve(
  import.meta.dir,
  "../mcp-surface-baseline.json",
);
const WRITE_HINT = "bun run mcp:surface-baseline --write";

// A derived total may sit this far from its baseline, in either direction,
// before the check fails: a sentence reworded in one description does not
// need a rewrite, while a new property, branch or tool does. Shrinking past it
// fails too, so headroom a change gave back cannot be spent later unreviewed.
// The tool count, the set of tools and the identity of the largest tool are
// exact.
const TOLERANCE_RATIO = 0.005;
const TOLERANCE_FLOOR = 50;

// Characters per token, for the estimate printed beside a drift and never for
// the gate. Measured 2026-09-26 with `scripts/mcp-surface-token-calibration.ts`
// (Anthropic count_tokens, claude-opus-5-5) across the four audiences: names
// and input schemas 2.4 to 2.6, descriptions and instructions 2.9 to 3.2. The
// estimate is a size, not a count; rerun the calibration to retune.
const CHARS_PER_TOKEN = { json: 2.4, prose: 3 } as const;
type TextKind = keyof typeof CHARS_PER_TOKEN;

const countSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

// --- Stored rows ------------------------------------------------------------
// One tool as one audience serves it. The name's length is the row key's
// length, so it is not stored.

const toolRowSchema = v.strictObject({
  title: countSchema,
  description: countSchema,
  inputSchema: countSchema,
  outputSchema: countSchema,
  annotations: countSchema,
  payloadUtf8Bytes: countSchema,
});

type ToolRow = v.InferOutput<typeof toolRowSchema>;

// The stored key order of a row.
const TOOL_ROW_FIELDS = [
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "payloadUtf8Bytes",
] as const satisfies readonly (keyof ToolRow)[];

type UnlistedToolRowField = Exclude<
  keyof ToolRow,
  (typeof TOOL_ROW_FIELDS)[number]
>;
true satisfies UnlistedToolRowField extends never ? true : never;

// Audiences are keyed by any string so that a row for an audience `MCP_MODES`
// no longer lists, or a missing row for a new one, is reported as drift rather
// than as a parse failure. Strict objects leave no room for a stored total.
const surfaceBaselineSchema = v.strictObject({
  instructions: v.record(v.string(), countSchema),
  tools: v.record(v.string(), v.record(v.string(), toolRowSchema)),
});

/** Per-audience instruction lengths and per-(tool, audience) rows. */
export type SurfaceRows = v.InferOutput<typeof surfaceBaselineSchema>;

// Code-unit order: stable across machines and locales.
const sortedKeys = (record: Record<string, unknown>): string[] =>
  Object.keys(record).toSorted();

const byCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const sortedEntries = <Value>(
  record: Record<string, Value>,
): [string, Value][] =>
  Object.entries(record).toSorted(([left], [right]) =>
    byCodeUnits(left, right),
  );

/** The audiences a set of rows describes, in stored order. */
export const baselineAudiences = (rows: SurfaceRows): string[] =>
  sortedKeys(rows.instructions);

// --- Derived measurements ---------------------------------------------------

type SurfaceChars = {
  name: number;
  title: number;
  description: number;
  inputSchema: number;
  outputSchema: number;
  annotations: number;
  instructions: number;
};
type SurfacePart = keyof SurfaceChars;

const SURFACE_PARTS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "instructions",
] as const satisfies readonly SurfacePart[];

type UnlistedSurfacePart = Exclude<SurfacePart, (typeof SURFACE_PARTS)[number]>;
true satisfies UnlistedSurfacePart extends never ? true : never;

const PART_TEXT_KIND = {
  name: "prose",
  title: "prose",
  description: "prose",
  inputSchema: "json",
  outputSchema: "json",
  annotations: "json",
  instructions: "prose",
} as const satisfies Record<SurfacePart, TextKind>;

type LargestTool = { tool: string; chars: number };

type SurfaceMeasurement = {
  tools: number;
  chars: SurfaceChars;
  payloadUtf8Bytes: number;
  largestDescription: LargestTool;
  largestInputSchema: LargestTool;
  largestOutputSchema: LargestTool;
};

const LARGEST_ROWS = [
  "largestDescription",
  "largestInputSchema",
  "largestOutputSchema",
] as const;
type LargestRow = (typeof LARGEST_ROWS)[number];

type UnlistedLargestRow = Exclude<
  {
    [
      Key in keyof SurfaceMeasurement
    ]: SurfaceMeasurement[Key] extends LargestTool ? Key : never;
  }[keyof SurfaceMeasurement],
  LargestRow
>;
true satisfies UnlistedLargestRow extends never ? true : never;

const LARGEST_ROW_FIELD = {
  largestDescription: "description",
  largestInputSchema: "inputSchema",
  largestOutputSchema: "outputSchema",
} as const satisfies Record<LargestRow, keyof ToolRow>;

type MeasuredSurface = {
  mode: string;
  measurement: SurfaceMeasurement;
};

// `tools/list` serves a JSON array: its items, a comma between each pair and
// the two brackets. Commas and brackets are one byte each.
const wirePayloadBytes = (toolBytes: readonly number[]): number =>
  toolBytes.reduce((sum, bytes) => sum + bytes, 0) +
  Math.max(toolBytes.length - 1, 0) +
  2;

const larger = (current: LargestTool, candidate: LargestTool): LargestTool =>
  candidate.chars > current.chars ? candidate : current;

// Tools are visited in stored order, so a tie for the largest entry goes to
// the tool that sorts first, the same way for the baseline and the registry.
const deriveSurface = (rows: SurfaceRows, mode: string): SurfaceMeasurement => {
  const chars: SurfaceChars = {
    name: 0,
    title: 0,
    description: 0,
    inputSchema: 0,
    outputSchema: 0,
    annotations: 0,
    instructions: rows.instructions[mode] ?? 0,
  };
  const toolBytes: number[] = [];
  const largest: Record<LargestRow, LargestTool> = {
    largestDescription: { tool: "", chars: 0 },
    largestInputSchema: { tool: "", chars: 0 },
    largestOutputSchema: { tool: "", chars: 0 },
  };

  for (const tool of sortedKeys(rows.tools)) {
    const row = rows.tools[tool]?.[mode];
    if (row === undefined) {
      continue;
    }
    chars.name += tool.length;
    chars.title += row.title;
    chars.description += row.description;
    chars.inputSchema += row.inputSchema;
    chars.outputSchema += row.outputSchema;
    chars.annotations += row.annotations;
    toolBytes.push(row.payloadUtf8Bytes);
    for (const largestRow of LARGEST_ROWS) {
      largest[largestRow] = larger(largest[largestRow], {
        tool,
        chars: row[LARGEST_ROW_FIELD[largestRow]],
      });
    }
  }

  return {
    tools: toolBytes.length,
    chars,
    payloadUtf8Bytes: wirePayloadBytes(toolBytes),
    ...largest,
  };
};

const deriveSurfaces = (rows: SurfaceRows): MeasuredSurface[] =>
  baselineAudiences(rows).map((mode) => ({
    mode,
    measurement: deriveSurface(rows, mode),
  }));

const toolsOf = (rows: SurfaceRows, mode: string): string[] =>
  sortedKeys(rows.tools).filter(
    (tool) => rows.tools[tool]?.[mode] !== undefined,
  );

// --- Measurement ------------------------------------------------------------

const jsonChars = (value: unknown): number =>
  value === undefined ? 0 : JSON.stringify(value).length;

// Imported on demand: loading the registry validates the API environment,
// and `--self-test` runs without one.
const loadMcpRegistry = async () => {
  const [constants, listTools, instructions, definitions] = await Promise.all([
    import("@/api/mcp/constants"),
    import("@/api/mcp/gateway/list-tools"),
    import("@/api/mcp/instructions"),
    import("@/api/mcp/static-tool-definitions"),
  ]);
  return {
    modes: constants.MCP_MODES,
    toMcpTools: listTools.toMcpTools,
    instructions: instructions.MCP_INSTRUCTIONS,
    listDefinitions: definitions.listStaticMcpToolDefinitions,
  };
};

/** Every audience's rows, measured from the canonical static registry. */
export const measureMcpSurfaces = async (): Promise<SurfaceRows> => {
  const registry = await loadMcpRegistry();
  const rows: SurfaceRows = { instructions: {}, tools: {} };

  for (const mode of registry.modes) {
    const tools = registry.toMcpTools(registry.listDefinitions(mode), { mode });
    rows.instructions[mode] = registry.instructions[mode].length;
    for (const tool of tools) {
      const audiences = rows.tools[tool.name] ?? {};
      rows.tools[tool.name] = audiences;
      if (audiences[mode] !== undefined) {
        return panic(`The ${mode} audience lists ${tool.name} twice`);
      }
      audiences[mode] = {
        title: (tool.title ?? "").length,
        description: (tool.description ?? "").length,
        inputSchema: jsonChars(tool.inputSchema),
        outputSchema: jsonChars(tool.outputSchema),
        annotations: jsonChars(tool.annotations),
        payloadUtf8Bytes: Buffer.byteLength(JSON.stringify(tool), "utf-8"),
      };
    }
    // The derived wire size must be the served one, byte for byte.
    const served = Buffer.byteLength(JSON.stringify(tools), "utf-8");
    const derived = deriveSurface(rows, mode).payloadUtf8Bytes;
    if (derived !== served) {
      return panic(
        `The ${mode} wire size derived from per-tool rows (${derived}) differs from the served tools/list (${served})`,
      );
    }
  }
  return rows;
};

// --- Views ------------------------------------------------------------------
// What a host hands the model, as sums of the measured parts (the host table
// with its observation date is in src/mcp/README.md). No host framing is
// modelled. The Codex term counts every output schema as JSON, which that
// host renders shorter, so it is an upper bound.

const SURFACE_VIEWS = [
  "anthropic",
  "deferredUpfront",
  "codexUpperBound",
] as const;
type SurfaceView = (typeof SURFACE_VIEWS)[number];

const VIEW_LABELS = {
  anthropic: "anthropic (name + description + inputSchema)",
  deferredUpfront: "deferred upfront (names + instructions)",
  codexUpperBound:
    "codex upper bound (instructions x tools + description + inputSchema + outputSchema)",
} as const satisfies Record<SurfaceView, string>;

type ViewTerm = { part: SurfacePart; times: number };

const viewTerms = (
  measurement: SurfaceMeasurement,
): Record<SurfaceView, readonly ViewTerm[]> => ({
  anthropic: [
    { part: "name", times: 1 },
    { part: "description", times: 1 },
    { part: "inputSchema", times: 1 },
  ],
  deferredUpfront: [
    { part: "name", times: 1 },
    { part: "instructions", times: 1 },
  ],
  codexUpperBound: [
    { part: "instructions", times: measurement.tools },
    { part: "description", times: 1 },
    { part: "inputSchema", times: 1 },
    { part: "outputSchema", times: 1 },
  ],
});

type ViewSize = { chars: number; estimatedTokens: number };

const estimateTokens = (part: SurfacePart, chars: number): number =>
  chars / CHARS_PER_TOKEN[PART_TEXT_KIND[part]];

const surfaceViews = (
  measurement: SurfaceMeasurement,
): Record<SurfaceView, ViewSize> => {
  const terms = viewTerms(measurement);
  const size = (view: SurfaceView): ViewSize => {
    let chars = 0;
    let estimatedTokens = 0;
    for (const { part, times } of terms[view]) {
      const partChars = measurement.chars[part] * times;
      chars += partChars;
      estimatedTokens += estimateTokens(part, partChars);
    }
    return { chars, estimatedTokens: Math.round(estimatedTokens) };
  };
  return {
    anthropic: size("anthropic"),
    deferredUpfront: size("deferredUpfront"),
    codexUpperBound: size("codexUpperBound"),
  };
};

// --- Baseline IO ------------------------------------------------------------
// The one accepted text of a set of rows. Each (tool, audience) row is one
// line, and each tool's rows are wrapped in their own block, so edits to two
// different tools, even neighbours in sort order, never touch adjacent lines.

const entryLines = (
  entries: readonly (readonly [string, string])[],
  indent: string,
): string[] =>
  entries.map(
    ([key, value], index) =>
      `${indent}${JSON.stringify(key)}: ${value}${index < entries.length - 1 ? "," : ""}`,
  );

const renderToolRow = (row: ToolRow): string =>
  `{${TOOL_ROW_FIELDS.map((field) => `${JSON.stringify(field)}: ${row[field]}`).join(", ")}}`;

export const toBaselineText = (rows: SurfaceRows): string => {
  const tools = sortedEntries(rows.tools);
  const lines = [
    "{",
    `  "instructions": {`,
    ...entryLines(
      sortedEntries(rows.instructions).map(
        ([mode, chars]) => [mode, String(chars)] as const,
      ),
      "    ",
    ),
    "  },",
    `  "tools": {`,
    ...tools.flatMap(([tool, audiences], index) =>
      [`    ${JSON.stringify(tool)}: {`].concat(
        entryLines(
          sortedEntries(audiences).map(
            ([mode, row]) => [mode, renderToolRow(row)] as const,
          ),
          "      ",
        ),
        `    }${index < tools.length - 1 ? "," : ""}`,
      ),
    ),
    "  }",
    "}",
  ];
  return `${lines.join("\n")}\n`;
};

type BaselineParse =
  | { ok: true; rows: SurfaceRows }
  | { ok: false; error: string };

const firstDifferentLine = (actual: string, expected: string): string => {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const index = expectedLines.findIndex(
    (line, lineIndex) => actualLines[lineIndex] !== line,
  );
  const at = index === -1 ? expectedLines.length : index;
  return `line ${at + 1} is ${JSON.stringify(actualLines[at] ?? "<end of file>")}, want ${JSON.stringify(expectedLines[at] ?? "<end of file>")}`;
};

/**
 * Parses the stored text and holds it to its format: the schema admits only
 * per-audience instruction lengths and per-(tool, audience) rows, every tool
 * has a row and every row's audience an instructions length, and the text is
 * byte for byte the sorted one-row-per-line rendering.
 */
export const parseMcpSurfaceBaseline = (text: string): BaselineParse => {
  const json = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(json)) {
    return { ok: false, error: "it is not valid JSON" };
  }
  const parsed = v.safeParse(surfaceBaselineSchema, json.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `it does not match its schema (${v.summarize(parsed.issues)})`,
    };
  }
  const rows = parsed.output;
  for (const tool of sortedKeys(rows.tools)) {
    const audiences = sortedKeys(rows.tools[tool] ?? {});
    if (audiences.length === 0) {
      return { ok: false, error: `tool ${tool} has no audience rows` };
    }
    const unlisted = audiences.find(
      (mode) => rows.instructions[mode] === undefined,
    );
    if (unlisted !== undefined) {
      return {
        ok: false,
        error: `tool ${tool} has a ${unlisted} row, but ${unlisted} has no instructions length`,
      };
    }
  }
  const canonical = toBaselineText(rows);
  if (text !== canonical) {
    return {
      ok: false,
      error: `it is not in its format (rows sorted by tool then audience, one per line; ${firstDifferentLine(text, canonical)})`,
    };
  }
  return { ok: true, rows };
};

const readBaselineFile = (): BaselineParse => {
  const parsed = parseMcpSurfaceBaseline(readFileSync(BASELINE_PATH, "utf-8"));
  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: `${BASELINE_REL}: ${parsed.error}; regenerate it with \`${WRITE_HINT}\``,
      };
};

export const readMcpSurfaceBaseline = (): SurfaceRows => {
  const parsed = readBaselineFile();
  return parsed.ok ? parsed.rows : panic(parsed.error);
};

// --- Comparison -------------------------------------------------------------

const allowedDrift = (baseline: number): number =>
  Math.max(Math.ceil(baseline * TOLERANCE_RATIO), TOLERANCE_FLOOR);

type CountMetric =
  | { type: "tools" }
  | { type: "payloadUtf8Bytes" }
  | { type: "part"; part: SurfacePart };

type SurfaceDrift =
  | { type: "missing_row"; mode: string }
  | { type: "unknown_row"; mode: string }
  | { type: "missing_tool"; mode: string; tool: string }
  | { type: "unknown_tool"; mode: string; tool: string }
  | {
      type: "count";
      mode: string;
      metric: CountMetric;
      baseline: number;
      current: number;
      tolerance: number;
    }
  | {
      type: "largest_tool";
      mode: string;
      row: LargestRow;
      baseline: LargestTool;
      current: LargestTool;
      tolerance: number;
    };

type CountComparison = {
  metric: CountMetric;
  baseline: number;
  current: number;
  tolerance: number;
};

type DiffSurfaceOptions = {
  mode: string;
  current: SurfaceMeasurement;
  baseline: SurfaceMeasurement;
};

const diffSurface = ({
  mode,
  current,
  baseline,
}: DiffSurfaceOptions): SurfaceDrift[] => {
  const counts: CountComparison[] = [
    {
      metric: { type: "tools" },
      baseline: baseline.tools,
      current: current.tools,
      tolerance: 0,
    },
    ...SURFACE_PARTS.map((part): CountComparison => ({
      metric: { type: "part", part },
      baseline: baseline.chars[part],
      current: current.chars[part],
      tolerance: allowedDrift(baseline.chars[part]),
    })),
    {
      metric: { type: "payloadUtf8Bytes" },
      baseline: baseline.payloadUtf8Bytes,
      current: current.payloadUtf8Bytes,
      tolerance: allowedDrift(baseline.payloadUtf8Bytes),
    },
  ];
  const drifts: SurfaceDrift[] = counts
    .filter(
      ({ baseline: before, current: after, tolerance }) =>
        Math.abs(after - before) > tolerance,
    )
    .map(
      ({
        metric,
        baseline: before,
        current: after,
        tolerance,
      }): SurfaceDrift => ({
        type: "count",
        mode,
        metric,
        baseline: before,
        current: after,
        tolerance,
      }),
    );

  for (const row of LARGEST_ROWS) {
    const before = baseline[row];
    const after = current[row];
    const tolerance = allowedDrift(before.chars);
    if (
      before.tool !== after.tool ||
      Math.abs(after.chars - before.chars) > tolerance
    ) {
      drifts.push({
        type: "largest_tool",
        mode,
        row,
        baseline: before,
        current: after,
        tolerance,
      });
    }
  }
  return drifts;
};

type DiffToolSetOptions = {
  mode: string;
  current: SurfaceRows;
  baseline: SurfaceRows;
};

// The rows name every tool, so a renamed or swapped tool is drift even when
// the count holds.
const diffToolSet = ({
  mode,
  current,
  baseline,
}: DiffToolSetOptions): SurfaceDrift[] => {
  const before = new Set(toolsOf(baseline, mode));
  const after = new Set(toolsOf(current, mode));
  return [
    ...[...before]
      .filter((tool) => !after.has(tool))
      .map((tool): SurfaceDrift => ({ type: "unknown_tool", mode, tool })),
    ...[...after]
      .filter((tool) => !before.has(tool))
      .map((tool): SurfaceDrift => ({ type: "missing_tool", mode, tool })),
  ];
};

export const diffMcpSurfaceBaseline = (
  current: SurfaceRows,
  baseline: SurfaceRows,
): SurfaceDrift[] => {
  const currentModes = new Set(baselineAudiences(current));
  const drifts: SurfaceDrift[] = baselineAudiences(baseline)
    .filter((mode) => !currentModes.has(mode))
    .map((mode): SurfaceDrift => ({ type: "unknown_row", mode }));

  for (const { mode, measurement } of deriveSurfaces(current)) {
    if (baseline.instructions[mode] === undefined) {
      drifts.push({ type: "missing_row", mode });
      continue;
    }
    drifts.push(
      ...diffToolSet({ mode, current, baseline }),
      ...diffSurface({
        mode,
        current: measurement,
        baseline: deriveSurface(baseline, mode),
      }),
    );
  }
  return drifts;
};

// --- Formatting -------------------------------------------------------------

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const signed = (value: number): string =>
  `${value >= 0 ? "+" : ""}${formatNumber(value)}`;

const metricLabel = (metric: CountMetric): string => {
  switch (metric.type) {
    case "tools":
    case "payloadUtf8Bytes":
      return metric.type;
    case "part":
      return `chars.${metric.part}`;
    default:
      metric satisfies never;
      return panic(`Unhandled count metric: ${JSON.stringify(metric)}`);
  }
};

type CountDriftDetailOptions = {
  metric: CountMetric;
  delta: number;
  tolerance: number;
};

const countDriftDetail = ({
  metric,
  delta,
  tolerance,
}: CountDriftDetailOptions): string => {
  switch (metric.type) {
    case "tools":
      return `${signed(delta)} tools; exact`;
    case "payloadUtf8Bytes":
      return `${signed(delta)} bytes; tolerance ±${formatNumber(tolerance)}`;
    case "part":
      return `${signed(delta)} chars, ~${signed(Math.round(estimateTokens(metric.part, delta)))} tokens est.; tolerance ±${formatNumber(tolerance)}`;
    default:
      metric satisfies never;
      return panic(`Unhandled count metric: ${JSON.stringify(metric)}`);
  }
};

const formatDrift = (drift: SurfaceDrift): string => {
  switch (drift.type) {
    case "missing_row":
      return `  ${drift.mode}: no baseline row for this audience`;
    case "unknown_row":
      return `  ${drift.mode}: baseline row for an audience MCP_MODES does not list`;
    case "missing_tool":
      return `  ${drift.mode} ${drift.tool}: no baseline row for this tool`;
    case "unknown_tool":
      return `  ${drift.mode} ${drift.tool}: baseline row for a tool this audience does not serve`;
    case "count":
      return `  ${drift.mode} ${metricLabel(drift.metric)}: ${formatNumber(drift.baseline)} -> ${formatNumber(drift.current)} (${countDriftDetail({ metric: drift.metric, delta: drift.current - drift.baseline, tolerance: drift.tolerance })})`;
    case "largest_tool":
      return `  ${drift.mode} ${drift.row}: ${drift.baseline.tool} ${formatNumber(drift.baseline.chars)} -> ${drift.current.tool} ${formatNumber(drift.current.chars)} chars`;
    default:
      drift satisfies never;
      return panic(`Unhandled surface drift: ${JSON.stringify(drift)}`);
  }
};

const formatViews = ({ mode, measurement }: MeasuredSurface): string[] => {
  const views = surfaceViews(measurement);
  return [
    `  ${mode} views:`,
    ...SURFACE_VIEWS.map(
      (view) =>
        `    ${VIEW_LABELS[view]}: ${formatNumber(views[view].chars)} chars, ~${formatNumber(views[view].estimatedTokens)} tokens est.`,
    ),
  ];
};

export const formatSurfaceDrifts = (
  drifts: readonly SurfaceDrift[],
  current: SurfaceRows,
): string => {
  const driftedModes = new Set(drifts.map(({ mode }) => mode));
  return [
    `The MCP tool surface drifted from ${BASELINE_REL}:`,
    ...drifts.map(formatDrift),
    ...deriveSurfaces(current)
      .filter(({ mode }) => driftedModes.has(mode))
      .flatMap(formatViews),
    `Rewrite the baseline with \`${WRITE_HINT}\` (from apps/api) and commit it; a pull request that grows a surface says why in its description.`,
  ].join("\n");
};

const formatReport = (rows: SurfaceRows): string =>
  deriveSurfaces(rows)
    .flatMap((surface) => {
      const { mode, measurement } = surface;
      return [
        `${mode}: ${measurement.tools} tools, ${formatNumber(measurement.payloadUtf8Bytes)} UTF-8 bytes on the wire`,
      ].concat(
        SURFACE_PARTS.map(
          (part) =>
            `  ${part.padEnd(13)} ${formatNumber(measurement.chars[part]).padStart(8)} chars`,
        ),
        LARGEST_ROWS.map(
          (row) =>
            `  ${row.padEnd(19)} ${measurement[row].tool} (${formatNumber(measurement[row].chars)})`,
        ),
        formatViews(surface),
        "",
      );
    })
    .join("\n");

// --- Self-test --------------------------------------------------------------
// Synthetic rows only: proves each kind of drift is reported, that in-tolerance
// churn is not, and that a file out of its format is rejected, without reading
// the registry or the committed file.

type SyntheticTool = "fetch" | "read_statute" | "search_case_law";

// Totals for law: description 3,600, inputSchema 5,300, outputSchema 4,050
// (each tolerance ±50); largest description and input schema search_case_law,
// largest output schema read_statute.
const syntheticToolRows = (): Record<SyntheticTool, ToolRow> => ({
  fetch: {
    title: 5,
    description: 1000,
    inputSchema: 1500,
    outputSchema: 1300,
    annotations: 95,
    payloadUtf8Bytes: 4000,
  },
  read_statute: {
    title: 12,
    description: 1200,
    inputSchema: 1800,
    outputSchema: 1400,
    annotations: 95,
    payloadUtf8Bytes: 4500,
  },
  search_case_law: {
    title: 15,
    description: 1400,
    inputSchema: 2000,
    outputSchema: 1350,
    annotations: 95,
    payloadUtf8Bytes: 5000,
  },
});

type LawRowsOptions = {
  edit?: (tools: Record<string, ToolRow>) => void;
  rename?: { from: SyntheticTool; to: string };
  instructions?: number;
};

const lawRows = ({
  edit,
  rename,
  instructions = 1200,
}: LawRowsOptions = {}): SurfaceRows => {
  const synthetic: Record<string, ToolRow> = syntheticToolRows();
  edit?.(synthetic);
  const tools = Object.fromEntries(
    Object.entries(synthetic).map(([tool, row]) => [
      tool === rename?.from ? rename.to : tool,
      row,
    ]),
  );
  return {
    instructions: { law: instructions },
    tools: Object.fromEntries(
      Object.entries(tools).map(([tool, row]) => [tool, { law: row }]),
    ),
  };
};

const toolRow = (
  tools: Record<string, ToolRow>,
  tool: SyntheticTool,
): ToolRow => tools[tool] ?? panic(`Synthetic tool ${tool} is missing`);

const driftLabel = (drift: SurfaceDrift): string => {
  switch (drift.type) {
    case "count":
      return `${drift.mode} ${metricLabel(drift.metric)}`;
    case "largest_tool":
      return `${drift.mode} ${drift.row}`;
    case "missing_tool":
    case "unknown_tool":
      return `${drift.mode} ${drift.type} ${drift.tool}`;
    case "missing_row":
    case "unknown_row":
      return `${drift.mode} ${drift.type}`;
    default:
      drift satisfies never;
      return panic(`Unhandled surface drift: ${JSON.stringify(drift)}`);
  }
};

const runComparisonSelfTest = (failures: string[]) => {
  const baseline = lawRows();
  const expectRows = ({
    label,
    current,
    expected,
  }: {
    label: string;
    current: SurfaceRows;
    expected: readonly string[];
  }) => {
    const rows = diffMcpSurfaceBaseline(current, baseline).map(driftLabel);
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      failures.push(
        `${label}: drifts ${JSON.stringify(rows)}, want ${JSON.stringify(expected)}`,
      );
    }
  };

  expectRows({ label: "identical", current: lawRows(), expected: [] });

  expectRows({
    label: "within tolerance",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "search_case_law").inputSchema += 40;
        toolRow(tools, "fetch").description -= 30;
        toolRow(tools, "read_statute").payloadUtf8Bytes += 60;
      },
    }),
    expected: [],
  });

  expectRows({
    label: "grew",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "fetch").outputSchema += 60;
      },
    }),
    expected: ["law chars.outputSchema"],
  });

  expectRows({
    label: "shrank",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "fetch").inputSchema -= 600;
      },
    }),
    expected: ["law chars.inputSchema"],
  });

  expectRows({
    label: "title and annotations are gated",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "fetch").title += 51;
        toolRow(tools, "read_statute").annotations += 51;
      },
    }),
    expected: ["law chars.title", "law chars.annotations"],
  });

  expectRows({
    label: "instructions grew",
    current: lawRows({ instructions: 1300 }),
    expected: ["law chars.instructions"],
  });

  expectRows({
    label: "tool count is exact",
    current: lawRows({
      edit: (tools) => {
        tools["list_matters"] = {
          title: 0,
          description: 0,
          inputSchema: 0,
          outputSchema: 0,
          annotations: 0,
          payloadUtf8Bytes: 0,
        };
      },
    }),
    expected: ["law missing_tool list_matters", "law tools"],
  });

  expectRows({
    label: "a renamed tool is drift at the same count",
    current: lawRows({ rename: { from: "fetch", to: "fetch_url" } }),
    expected: ["law unknown_tool fetch", "law missing_tool fetch_url"],
  });

  expectRows({
    label: "largest tool changed",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "fetch").description += 410;
        toolRow(tools, "search_case_law").description -= 410;
      },
    }),
    expected: ["law largestDescription"],
  });

  expectRows({
    label: "wire size grew",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "fetch").payloadUtf8Bytes += 1000;
      },
    }),
    expected: ["law payloadUtf8Bytes"],
  });

  expectRows({
    label: "largest tool grew past tolerance",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "read_statute").outputSchema += 60;
        toolRow(tools, "fetch").outputSchema -= 60;
      },
    }),
    expected: ["law largestOutputSchema"],
  });

  expectRows({
    label: "largest tool within tolerance",
    current: lawRows({
      edit: (tools) => {
        toolRow(tools, "search_case_law").inputSchema += 20;
      },
    }),
    expected: [],
  });

  const documents = lawRows();
  expectRows({
    label: "missing and unknown rows",
    current: {
      instructions: { documents: 1200 },
      tools: Object.fromEntries(
        Object.entries(documents.tools).map(([tool, audiences]) => [
          tool,
          { documents: audiences["law"] ?? panic(tool) },
        ]),
      ),
    },
    expected: ["law unknown_row", "documents missing_row"],
  });

  if (allowedDrift(100) !== TOLERANCE_FLOOR) {
    failures.push(`allowedDrift(100) = ${allowedDrift(100)}, want the floor`);
  }
  if (allowedDrift(100_000) !== 500) {
    failures.push(`allowedDrift(100_000) = ${allowedDrift(100_000)}, want 500`);
  }
};

const runDerivationSelfTest = (failures: string[]) => {
  const measurement = deriveSurface(lawRows(), "law");
  const expected: SurfaceMeasurement = {
    tools: 3,
    chars: {
      name: "fetch".length + "read_statute".length + "search_case_law".length,
      title: 32,
      description: 3600,
      inputSchema: 5300,
      outputSchema: 4050,
      annotations: 285,
      instructions: 1200,
    },
    payloadUtf8Bytes: 13_500 + 2 + 2,
    largestDescription: { tool: "search_case_law", chars: 1400 },
    largestInputSchema: { tool: "search_case_law", chars: 2000 },
    largestOutputSchema: { tool: "read_statute", chars: 1400 },
  };
  if (JSON.stringify(measurement) !== JSON.stringify(expected)) {
    failures.push(
      `derived law surface ${JSON.stringify(measurement)}, want ${JSON.stringify(expected)}`,
    );
  }

  // A tie goes to the tool that sorts first, whatever order rows arrive in.
  const tied = lawRows({
    edit: (tools) => {
      toolRow(tools, "fetch").inputSchema = 2000;
    },
  });
  const reversed: SurfaceRows = {
    ...tied,
    tools: Object.fromEntries(Object.entries(tied.tools).toReversed()),
  };
  const tiedLargest = deriveSurface(reversed, "law").largestInputSchema.tool;
  if (tiedLargest !== "fetch") {
    failures.push(`tied largest input schema is ${tiedLargest}, want fetch`);
  }

  // The derived wire size is the size of the served array.
  const wireTools = [
    { name: "a", description: "Příliš žluťoučký kůň" },
    { name: "b", title: "“quoted”" },
    { name: "c" },
  ];
  const served = Buffer.byteLength(JSON.stringify(wireTools), "utf-8");
  const derived = wirePayloadBytes(
    wireTools.map((tool) => Buffer.byteLength(JSON.stringify(tool), "utf-8")),
  );
  if (derived !== served) {
    failures.push(`derived wire size ${derived}, want ${served}`);
  }
  if (wirePayloadBytes([]) !== Buffer.byteLength("[]")) {
    failures.push(`empty wire size ${wirePayloadBytes([])}, want 2`);
  }

  const views = surfaceViews(measurement);
  const expectedViews = {
    anthropic: expected.chars.name + 3600 + 5300,
    deferredUpfront: expected.chars.name + 1200,
    codexUpperBound: 1200 * 3 + 3600 + 5300 + 4050,
  } as const satisfies Record<SurfaceView, number>;
  for (const view of SURFACE_VIEWS) {
    if (views[view].chars !== expectedViews[view]) {
      failures.push(
        `${view} view = ${views[view].chars}, want ${expectedViews[view]}`,
      );
    }
  }
};

const parseMcpSurfaceToolOrder = (text: string): string[] => {
  const json = Result.try((): unknown => JSON.parse(text));
  const parsed = Result.isOk(json)
    ? v.safeParse(surfaceBaselineSchema, json.value)
    : undefined;
  return parsed?.success === true ? Object.keys(parsed.output.tools) : [];
};

const runFormatSelfTest = (failures: string[]) => {
  const synthetic = syntheticToolRows();
  const rows: SurfaceRows = {
    instructions: { law: 1200, default: 1700 },
    tools: {
      search_case_law: {
        law: synthetic.search_case_law,
        default: synthetic.search_case_law,
      },
      fetch: { default: synthetic.fetch },
    },
  };
  const canonical = toBaselineText(rows);
  // `want` is "accepted", or a fragment the rejection must contain.
  const expectFormat = (label: string, text: string, want: string) => {
    const parsed = parseMcpSurfaceBaseline(text);
    const got = parsed.ok ? "accepted" : parsed.error;
    if (!got.includes(want)) {
      failures.push(`${label}: ${got}, want ${want}`);
    }
  };
  const NOT_IN_FORMAT = "not in its format";
  const NOT_IN_SCHEMA = "does not match its schema";

  expectFormat("canonical text", canonical, "accepted");
  const reparsed = parseMcpSurfaceBaseline(canonical);
  if (!reparsed.ok || toBaselineText(reparsed.rows) !== canonical) {
    failures.push("canonical text does not round-trip");
  }

  // Sorted by tool, then audience; one row per line; each tool in its block,
  // so neighbouring tools' rows never share a hunk.
  const expectedText = [
    "{",
    `  "instructions": {`,
    `    "default": 1700,`,
    `    "law": 1200`,
    "  },",
    `  "tools": {`,
    `    "fetch": {`,
    `      "default": {"title": 5, "description": 1000, "inputSchema": 1500, "outputSchema": 1300, "annotations": 95, "payloadUtf8Bytes": 4000}`,
    "    },",
    `    "search_case_law": {`,
    `      "default": {"title": 15, "description": 1400, "inputSchema": 2000, "outputSchema": 1350, "annotations": 95, "payloadUtf8Bytes": 5000},`,
    `      "law": {"title": 15, "description": 1400, "inputSchema": 2000, "outputSchema": 1350, "annotations": 95, "payloadUtf8Bytes": 5000}`,
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  if (canonical !== expectedText) {
    failures.push(`rendered text:\n${canonical}\nwant:\n${expectedText}`);
  }

  // Same rows, same lines, only the two tool blocks swapped.
  const fetchStart = canonical.indexOf(`    "fetch": {`);
  const searchStart = canonical.indexOf(`    "search_case_law": {`);
  const searchEnd =
    canonical.indexOf("    }\n", searchStart) + "    }\n".length;
  const fetchBlock = canonical.slice(fetchStart, searchStart);
  const searchBlock = canonical.slice(searchStart, searchEnd);
  const unsortedTools =
    canonical.slice(0, fetchStart) +
    searchBlock.replace(/\}\n$/u, "},\n") +
    fetchBlock.replace(/\},\n$/u, "}\n") +
    canonical.slice(searchEnd);
  const unsortedOrder = parseMcpSurfaceToolOrder(unsortedTools);
  if (JSON.stringify(unsortedOrder) !== `["search_case_law","fetch"]`) {
    failures.push(
      `the unsorted-tools fixture lists ${JSON.stringify(unsortedOrder)}`,
    );
  }
  expectFormat("unsorted tools", unsortedTools, NOT_IN_FORMAT);
  expectFormat(
    "unsorted audiences",
    canonical.replace(
      `    "default": 1700,\n    "law": 1200\n`,
      `    "law": 1200,\n    "default": 1700\n`,
    ),
    NOT_IN_FORMAT,
  );
  expectFormat("rows on one line", `${JSON.stringify(rows)}\n`, NOT_IN_FORMAT);
  expectFormat(
    "a row over several lines",
    `${JSON.stringify(rows, null, 2)}\n`,
    NOT_IN_FORMAT,
  );
  expectFormat("missing final newline", canonical.trimEnd(), NOT_IN_FORMAT);
  expectFormat(
    "stored per-audience totals",
    `${JSON.stringify({ surfaces: { law: { tools: 3, payloadUtf8Bytes: 13_504 } } })}\n`,
    NOT_IN_SCHEMA,
  );
  expectFormat(
    "a stored total beside the rows",
    canonical.replace(
      `  "tools": {`,
      `  "payloadUtf8Bytes": {"law": 5004},\n  "tools": {`,
    ),
    NOT_IN_SCHEMA,
  );
  expectFormat(
    "a stored total inside a row",
    canonical.replace(
      `"payloadUtf8Bytes": 4000}`,
      `"payloadUtf8Bytes": 4000, "chars": 1}`,
    ),
    NOT_IN_SCHEMA,
  );
  expectFormat(
    "a row missing a part",
    canonical.replace(
      `"annotations": 95, "payloadUtf8Bytes": 4000`,
      `"payloadUtf8Bytes": 4000`,
    ),
    NOT_IN_SCHEMA,
  );
  expectFormat(
    "a row for an audience without instructions",
    toBaselineText({
      ...rows,
      tools: { ...rows.tools, fetch: { documents: synthetic.fetch } },
    }),
    "documents has no instructions length",
  );
  expectFormat(
    "a tool without rows",
    toBaselineText({ ...rows, tools: { ...rows.tools, fetch: {} } }),
    "fetch has no audience rows",
  );
  expectFormat("not JSON", "{\n", "not valid JSON");
};

const runSelfTest = (): string[] => {
  const failures: string[] = [];
  runComparisonSelfTest(failures);
  runDerivationSelfTest(failures);
  runFormatSelfTest(failures);
  return failures;
};

// --- Entry ------------------------------------------------------------------

const main = async (): Promise<number> => {
  if (process.argv.includes("--self-test")) {
    const failures = runSelfTest();
    if (failures.length > 0) {
      console.error("mcp-surface-baseline --self-test: FAIL");
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
      return 1;
    }
    console.log("mcp-surface-baseline --self-test: PASS");
    return 0;
  }

  const current = await measureMcpSurfaces();
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE_PATH, toBaselineText(current));
    console.log(`Wrote ${BASELINE_REL}.\n\n${formatReport(current)}`);
    return 0;
  }
  if (process.argv.includes("--check")) {
    const baseline = readBaselineFile();
    if (!baseline.ok) {
      printError(baseline.error);
      return 1;
    }
    const drifts = diffMcpSurfaceBaseline(current, baseline.rows);
    if (drifts.length > 0) {
      console.error(formatSurfaceDrifts(drifts, current));
      return 1;
    }
    console.log(
      `mcp-surface-baseline --check: OK (${baselineAudiences(current).length} audiences).`,
    );
    return 0;
  }
  console.log(formatReport(current));
  return 0;
};

if (import.meta.main) {
  // Exit explicitly: importing the registry opens handles that would keep the
  // process alive after the report.
  process.exit(await main());
}
