import { panic } from "better-result";

import { RENDER_CAUSES, type RenderSnapshot } from "@stll/render-probe";

import type { RenderActionMeasurement } from "../helpers/render-probe";

export type CensusSample = {
  flow: string;
  measurements: readonly RenderActionMeasurement[];
};

type Distribution = { median: number; min: number; max: number };

export const summarizeDistribution = (
  values: readonly number[],
): Distribution => {
  const sorted = values.toSorted((left, right) => left - right);
  const min = sorted.at(0);
  const max = sorted.at(-1);
  const upper = sorted.at(Math.floor(sorted.length / 2));
  const lower = sorted.at(Math.ceil(sorted.length / 2) - 1);
  if (
    min === undefined ||
    max === undefined ||
    upper === undefined ||
    lower === undefined
  ) {
    return panic("A census distribution requires at least one sample");
  }
  return { median: (lower + upper) / 2, min, max };
};

const summarizeCauses = (values: readonly RenderSnapshot["causes"][]) => {
  const cause = (name: keyof RenderSnapshot["causes"]) =>
    summarizeDistribution(values.map((value) => value[name]));
  return {
    mount: cause("mount"),
    props: cause("props"),
    parent: cause("parent"),
    state: cause("state"),
    context: cause("context"),
  } satisfies Record<keyof RenderSnapshot["causes"], Distribution>;
};

const EMPTY_CAUSES = {
  mount: 0,
  props: 0,
  parent: 0,
  state: 0,
  context: 0,
} satisfies RenderSnapshot["causes"];

const summarizeOptionalMetric = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value) => value !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== values.length) {
    return panic("Census metric presence changed between action samples");
  }
  return summarizeDistribution(present);
};

const summarizeComponents = (
  measurements: readonly RenderActionMeasurement[],
) => {
  const names = new Set(
    measurements.flatMap(({ components }) => Object.keys(components)),
  );
  return [...names]
    .map((name) => ({
      name,
      renders: summarizeDistribution(
        measurements.map(({ components }) => components[name]?.renders ?? 0),
      ),
      causes: summarizeCauses(
        measurements.map(
          ({ components }) => components[name]?.causes ?? EMPTY_CAUSES,
        ),
      ),
    }))
    .toSorted(
      (left, right) =>
        right.renders.median - left.renders.median ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 10);
};

const summarizeAction = (
  flow: string,
  measurements: readonly RenderActionMeasurement[],
) => {
  const first = measurements.at(0);
  if (first === undefined) {
    return panic("A census action requires at least one sample");
  }
  const metric = (
    name:
      | "renders"
      | "commits"
      | "widestCommit"
      | "wallMs"
      | "longTasks"
      | "longTaskMs",
  ) =>
    summarizeDistribution(measurements.map((measurement) => measurement[name]));
  return {
    flow,
    label: first.label,
    samples: measurements.length,
    renders: metric("renders"),
    commits: metric("commits"),
    widestCommit: metric("widestCommit"),
    parentRenders: summarizeDistribution(
      measurements.map(({ causes }) => causes.parent),
    ),
    wallMs: metric("wallMs"),
    longTasks: metric("longTasks"),
    longTaskMs: metric("longTaskMs"),
    textDeltas: summarizeOptionalMetric(
      measurements.map(({ textDeltas }) => textDeltas),
    ),
    rendersPerDelta: summarizeOptionalMetric(
      measurements.map(({ rendersPerDelta }) => rendersPerDelta),
    ),
    causes: summarizeCauses(measurements.map(({ causes }) => causes)),
    components: summarizeComponents(measurements),
  };
};

export type CensusActionSummary = ReturnType<typeof summarizeAction>;

export const summarizeCensus = (
  samples: readonly CensusSample[],
): CensusActionSummary[] => {
  const flows = new Map<string, Map<string, RenderActionMeasurement[]>>();
  for (const { flow, measurements } of samples) {
    if (measurements.length === 0) {
      return panic(`Census flow ${flow} produced no action measurements`);
    }
    const seen = new Set<string>();
    let actions = flows.get(flow);
    const existing = actions !== undefined;
    if (actions === undefined) {
      actions = new Map();
      flows.set(flow, actions);
    }
    for (const measurement of measurements) {
      if (seen.has(measurement.label)) {
        return panic(`Duplicate census action ${flow}: ${measurement.label}`);
      }
      seen.add(measurement.label);
      const values = actions.get(measurement.label);
      if (values !== undefined) {
        values.push(measurement);
        continue;
      }
      if (existing) {
        return panic(`Census action set changed between samples for ${flow}`);
      }
      actions.set(measurement.label, [measurement]);
    }
    if (seen.size !== actions.size) {
      return panic(`Census action set changed between samples for ${flow}`);
    }
  }
  return [...flows]
    .flatMap(([flow, actions]) =>
      [...actions.values()].map((measurements) =>
        summarizeAction(flow, measurements),
      ),
    )
    .toSorted(
      (left, right) =>
        right.renders.median - left.renders.median ||
        left.flow.localeCompare(right.flow) ||
        left.label.localeCompare(right.label),
    );
};

const cell = (value: string) =>
  value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
const number = (value: number) => Number(value.toFixed(2)).toString();
const distribution = ({ median, min, max }: Distribution) =>
  `${number(median)} (${number(min)}–${number(max)})`;

export const formatCensusReport = (
  actions: readonly CensusActionSummary[],
): string => {
  const lines = [
    "# Render census",
    "",
    "Values are median (min–max); actions are ranked by component renders. Warm-up samples are excluded. Wall time ends at the last React commit and excludes the quiet window.",
    "",
    "| Flow / action | Samples | Renders | Commits | Widest commit | Parent renders | Wall ms | Long tasks | Long task ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...actions.map(
      (action) =>
        `| ${cell(action.flow)} / ${cell(action.label)} | ${action.samples} | ${distribution(action.renders)} | ${distribution(action.commits)} | ${distribution(action.widestCommit)} | ${distribution(action.parentRenders)} | ${distribution(action.wallMs)} | ${distribution(action.longTasks)} | ${distribution(action.longTaskMs)} |`,
    ),
  ];
  for (const action of actions) {
    const streamMetrics = [
      ...(action.textDeltas === undefined
        ? []
        : [`Text deltas: ${distribution(action.textDeltas)}.`]),
      ...(action.rendersPerDelta === undefined
        ? []
        : [`Renders per text delta: ${distribution(action.rendersPerDelta)}.`]),
    ];
    lines.push(
      "",
      `## ${cell(action.flow)} / ${cell(action.label)}`,
      "",
      `Cause totals: ${RENDER_CAUSES.map((cause) => `${cause} ${distribution(action.causes[cause])}`).join(", ")}.`,
      ...streamMetrics,
      "",
      "| Component | Renders | Mount | Props | Parent | State | Context |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...action.components.map(
        (component) =>
          `| ${cell(component.name)} | ${distribution(component.renders)} | ${RENDER_CAUSES.map((cause) => distribution(component.causes[cause])).join(" | ")} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
};
