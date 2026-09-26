// MCP tool-surface baseline.
//
// Measures what each audience advertises, per part, against a committed
// baseline: the tool count, the UTF-16 length of every part a host may put in
// front of a model (name, title, description, input and output schema,
// annotations, the connect-time instructions), the UTF-8 size of the served
// `tools/list` array, and the largest description, input schema and output
// schema. Every
// audience in `MCP_MODES` is read from the canonical registry and serialized
// with its own mode, exactly as `tools/list` serves it.
//
// A change that moves a row past its tolerance rewrites the baseline, so
// review sees the number diff and the pull request argues for it. The gate is
// `src/mcp/registry-quality.test.ts`, which reads the same file. Fixed caps
// are not measurements and stay with their owners: the per-tool ceilings in
// that test, the per-audience instruction ceilings in `src/mcp/instructions.ts`.
//
// Modes (from apps/api):
//   bun run mcp:surface-baseline                report parts and views
//   bun run mcp:surface-baseline --write        rewrite the baseline
//   bun run mcp:surface-baseline --check        exit 1 when a row drifted
//   bun run mcp:surface-baseline --self-test    prove the comparison fires

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import type { McpMode } from "@/api/mcp/constants";

const BASELINE_REL = "apps/api/mcp-surface-baseline.json";
const BASELINE_PATH = path.resolve(
  import.meta.dir,
  "../mcp-surface-baseline.json",
);
const WRITE_HINT = "bun run mcp:surface-baseline --write";

// A row may sit this far from its baseline, in either direction, before the
// check fails: a sentence reworded in one description does not need a
// rewrite, while a new property, branch or tool does. Shrinking past it fails
// too, so headroom a change gave back cannot be spent later unreviewed. The
// tool count and the identity of the largest tool are exact.
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

const surfaceCharsSchema = v.strictObject({
  name: countSchema,
  title: countSchema,
  description: countSchema,
  inputSchema: countSchema,
  outputSchema: countSchema,
  annotations: countSchema,
  instructions: countSchema,
});

type SurfaceChars = v.InferOutput<typeof surfaceCharsSchema>;
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

const largestToolSchema = v.strictObject({
  tool: v.string(),
  chars: countSchema,
});

type LargestTool = v.InferOutput<typeof largestToolSchema>;

const surfaceMeasurementSchema = v.strictObject({
  tools: countSchema,
  chars: surfaceCharsSchema,
  payloadUtf8Bytes: countSchema,
  largestDescription: largestToolSchema,
  largestInputSchema: largestToolSchema,
  largestOutputSchema: largestToolSchema,
});

type SurfaceMeasurement = v.InferOutput<typeof surfaceMeasurementSchema>;

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

// Rows are keyed by any string so that a row for an audience `MCP_MODES` no
// longer lists, or a missing row for a new one, is reported as drift rather
// than as a parse failure.
const surfaceBaselineSchema = v.strictObject({
  surfaces: v.record(v.string(), surfaceMeasurementSchema),
});

type SurfaceBaseline = v.InferOutput<typeof surfaceBaselineSchema>;

type MeasuredSurface = {
  mode: McpMode;
  measurement: SurfaceMeasurement;
};

// --- Measurement ------------------------------------------------------------

const emptyChars = (): SurfaceChars => ({
  name: 0,
  title: 0,
  description: 0,
  inputSchema: 0,
  outputSchema: 0,
  annotations: 0,
  instructions: 0,
});

const jsonChars = (value: unknown): number =>
  value === undefined ? 0 : JSON.stringify(value).length;

const larger = (current: LargestTool, candidate: LargestTool): LargestTool =>
  candidate.chars > current.chars ? candidate : current;

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

type McpRegistry = Awaited<ReturnType<typeof loadMcpRegistry>>;

const measureMcpSurface = (
  registry: McpRegistry,
  mode: McpMode,
): SurfaceMeasurement => {
  const tools = registry.toMcpTools(registry.listDefinitions(mode), mode);
  const chars = emptyChars();
  let largestDescription: LargestTool = { tool: "", chars: 0 };
  let largestInputSchema: LargestTool = { tool: "", chars: 0 };
  let largestOutputSchema: LargestTool = { tool: "", chars: 0 };

  for (const tool of tools) {
    const descriptionChars = (tool.description ?? "").length;
    const inputSchemaChars = jsonChars(tool.inputSchema);
    const outputSchemaChars = jsonChars(tool.outputSchema);
    chars.name += tool.name.length;
    chars.title += (tool.title ?? "").length;
    chars.description += descriptionChars;
    chars.inputSchema += inputSchemaChars;
    chars.outputSchema += outputSchemaChars;
    chars.annotations += jsonChars(tool.annotations);
    largestDescription = larger(largestDescription, {
      tool: tool.name,
      chars: descriptionChars,
    });
    largestInputSchema = larger(largestInputSchema, {
      tool: tool.name,
      chars: inputSchemaChars,
    });
    largestOutputSchema = larger(largestOutputSchema, {
      tool: tool.name,
      chars: outputSchemaChars,
    });
  }
  chars.instructions = registry.instructions[mode].length;

  return {
    tools: tools.length,
    chars,
    payloadUtf8Bytes: Buffer.byteLength(JSON.stringify(tools), "utf-8"),
    largestDescription,
    largestInputSchema,
    largestOutputSchema,
  };
};

export const measureMcpSurfaces = async (): Promise<MeasuredSurface[]> => {
  const registry = await loadMcpRegistry();
  return registry.modes.map((mode) => ({
    mode,
    measurement: measureMcpSurface(registry, mode),
  }));
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

const toBaselineJson = (surfaces: readonly MeasuredSurface[]): string =>
  `${JSON.stringify(
    {
      surfaces: Object.fromEntries(
        surfaces.map(({ mode, measurement }) => [mode, measurement]),
      ),
    },
    null,
    2,
  )}\n`;

const parseMcpSurfaceBaseline = (raw: unknown) =>
  v.safeParse(surfaceBaselineSchema, raw);

export const readMcpSurfaceBaseline = (): SurfaceBaseline => {
  const parsed = parseMcpSurfaceBaseline(
    JSON.parse(readFileSync(BASELINE_PATH, "utf-8")),
  );
  if (!parsed.success) {
    return panic(
      `${BASELINE_REL} does not match its schema (${v.summarize(parsed.issues)}); regenerate it with \`${WRITE_HINT}\``,
    );
  }
  return parsed.output;
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

export const diffMcpSurfaceBaseline = (
  current: readonly MeasuredSurface[],
  baseline: SurfaceBaseline,
): SurfaceDrift[] => {
  const drifts: SurfaceDrift[] = Object.keys(baseline.surfaces)
    .filter((mode) => !current.some((surface) => surface.mode === mode))
    .map((mode): SurfaceDrift => ({ type: "unknown_row", mode }));

  for (const { mode, measurement } of current) {
    const row = baseline.surfaces[mode];
    if (row === undefined) {
      drifts.push({ type: "missing_row", mode });
      continue;
    }
    drifts.push(...diffSurface({ mode, current: measurement, baseline: row }));
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
  current: readonly MeasuredSurface[],
): string => {
  const driftedModes = new Set(drifts.map(({ mode }) => mode));
  return [
    `The MCP tool surface drifted from ${BASELINE_REL}:`,
    ...drifts.map(formatDrift),
    ...current
      .filter(({ mode }) => driftedModes.has(mode))
      .flatMap(formatViews),
    `Rewrite the baseline with \`${WRITE_HINT}\` (from apps/api) and commit it; a pull request that grows a surface says why in its description.`,
  ].join("\n");
};

const formatReport = (surfaces: readonly MeasuredSurface[]): string =>
  surfaces
    .flatMap((surface) => {
      const { mode, measurement } = surface;
      return [
        `${mode}: ${measurement.tools} tools, ${formatNumber(measurement.payloadUtf8Bytes)} UTF-8 bytes on the wire`,
        ...SURFACE_PARTS.map(
          (part) =>
            `  ${part.padEnd(13)} ${formatNumber(measurement.chars[part]).padStart(8)} chars`,
        ),
        ...LARGEST_ROWS.map(
          (row) =>
            `  ${row.padEnd(19)} ${measurement[row].tool} (${formatNumber(measurement[row].chars)})`,
        ),
        ...formatViews(surface),
        "",
      ];
    })
    .join("\n");

// --- Self-test --------------------------------------------------------------
// Synthetic rows only: proves each kind of drift is reported and that
// in-tolerance churn is not, without reading the registry or the file.

const syntheticSurface = (): SurfaceMeasurement => ({
  tools: 10,
  chars: {
    name: 180,
    title: 200,
    description: 6000,
    inputSchema: 10_000,
    outputSchema: 10_000,
    annotations: 950,
    instructions: 1200,
  },
  payloadUtf8Bytes: 28_000,
  largestDescription: { tool: "search_case_law", chars: 800 },
  largestInputSchema: { tool: "search_case_law", chars: 2000 },
  largestOutputSchema: { tool: "read_statute", chars: 1400 },
});

const withSurface = (
  measurement: SurfaceMeasurement,
): readonly MeasuredSurface[] => [{ mode: "law", measurement }];

const runSelfTest = (): string[] => {
  const failures: string[] = [];
  const baseline: SurfaceBaseline = {
    surfaces: { law: syntheticSurface() },
  };
  const expectRows = ({
    label,
    current,
    expected,
  }: {
    label: string;
    current: readonly MeasuredSurface[];
    expected: readonly string[];
  }) => {
    const rows = diffMcpSurfaceBaseline(current, baseline).map((drift) => {
      switch (drift.type) {
        case "count":
          return `${drift.mode} ${metricLabel(drift.metric)}`;
        case "largest_tool":
          return `${drift.mode} ${drift.row}`;
        case "missing_row":
        case "unknown_row":
          return `${drift.mode} ${drift.type}`;
        default:
          drift satisfies never;
          return panic(`Unhandled surface drift: ${JSON.stringify(drift)}`);
      }
    });
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      failures.push(
        `${label}: drifts ${JSON.stringify(rows)}, want ${JSON.stringify(expected)}`,
      );
    }
  };

  expectRows({
    label: "identical",
    current: withSurface(syntheticSurface()),
    expected: [],
  });

  const churn = syntheticSurface();
  churn.chars.inputSchema += 50;
  churn.chars.description -= 30;
  churn.payloadUtf8Bytes += 80;
  expectRows({
    label: "within tolerance",
    current: withSurface(churn),
    expected: [],
  });

  const grew = syntheticSurface();
  grew.chars.outputSchema += 900;
  expectRows({
    label: "grew",
    current: withSurface(grew),
    expected: ["law chars.outputSchema"],
  });

  const shrank = syntheticSurface();
  shrank.chars.inputSchema -= 2000;
  expectRows({
    label: "shrank",
    current: withSurface(shrank),
    expected: ["law chars.inputSchema"],
  });

  const extraTool = syntheticSurface();
  extraTool.tools += 1;
  expectRows({
    label: "tool count is exact",
    current: withSurface(extraTool),
    expected: ["law tools"],
  });

  const newLargest = syntheticSurface();
  newLargest.largestDescription = { tool: "fetch", chars: 801 };
  expectRows({
    label: "largest tool changed",
    current: withSurface(newLargest),
    expected: ["law largestDescription"],
  });

  const heavierPayload = syntheticSurface();
  heavierPayload.payloadUtf8Bytes += 1000;
  expectRows({
    label: "wire size grew",
    current: withSurface(heavierPayload),
    expected: ["law payloadUtf8Bytes"],
  });

  const largestGrew = syntheticSurface();
  largestGrew.largestOutputSchema = { tool: "read_statute", chars: 1500 };
  expectRows({
    label: "largest tool grew past tolerance",
    current: withSurface(largestGrew),
    expected: ["law largestOutputSchema"],
  });

  const largestChurn = syntheticSurface();
  largestChurn.largestInputSchema = { tool: "search_case_law", chars: 2020 };
  expectRows({
    label: "largest tool within tolerance",
    current: withSurface(largestChurn),
    expected: [],
  });

  expectRows({
    label: "missing and unknown rows",
    current: [{ mode: "documents", measurement: syntheticSurface() }],
    expected: ["law unknown_row", "documents missing_row"],
  });

  if (allowedDrift(100) !== TOLERANCE_FLOOR) {
    failures.push(`allowedDrift(100) = ${allowedDrift(100)}, want the floor`);
  }
  if (allowedDrift(100_000) !== 500) {
    failures.push(`allowedDrift(100_000) = ${allowedDrift(100_000)}, want 500`);
  }

  const views = surfaceViews(syntheticSurface());
  const expectedViews = {
    anthropic: 180 + 6000 + 10_000,
    deferredUpfront: 180 + 1200,
    codexUpperBound: 1200 * 10 + 6000 + 10_000 + 10_000,
  } as const satisfies Record<SurfaceView, number>;
  for (const view of SURFACE_VIEWS) {
    if (views[view].chars !== expectedViews[view]) {
      failures.push(
        `${view} view = ${views[view].chars}, want ${expectedViews[view]}`,
      );
    }
  }

  const withoutInstructions = {
    surfaces: {
      law: {
        ...syntheticSurface(),
        chars: Object.fromEntries(
          Object.entries(syntheticSurface().chars).filter(
            ([part]) => part !== "instructions",
          ),
        ),
      },
    },
  };
  if (parseMcpSurfaceBaseline(withoutInstructions).success) {
    failures.push("a row missing a part parsed as a baseline");
  }

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

  const surfaces = await measureMcpSurfaces();
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE_PATH, toBaselineJson(surfaces));
    console.log(`Wrote ${BASELINE_REL}.\n\n${formatReport(surfaces)}`);
    return 0;
  }
  if (process.argv.includes("--check")) {
    const drifts = diffMcpSurfaceBaseline(surfaces, readMcpSurfaceBaseline());
    if (drifts.length > 0) {
      console.error(formatSurfaceDrifts(drifts, surfaces));
      return 1;
    }
    console.log(
      `mcp-surface-baseline --check: OK (${surfaces.length} audiences).`,
    );
    return 0;
  }
  console.log(formatReport(surfaces));
  return 0;
};

if (import.meta.main) {
  // Exit explicitly: importing the registry opens handles that would keep the
  // process alive after the report.
  process.exit(await main());
}
