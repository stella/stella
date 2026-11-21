import { describe, expect, test } from "bun:test";

import type { RenderSnapshot } from "@stll/render-probe";

import {
  type CensusSample,
  formatCensusReport,
  summarizeCensus,
  summarizeDistribution,
} from "../agent/render-census-report";
import type { RenderActionMeasurement } from "../helpers/render-probe";

const causes = (parent: number) =>
  ({
    mount: 0,
    props: 0,
    parent,
    state: 0,
    context: 0,
  }) satisfies RenderSnapshot["causes"];

const measurement = (
  overrides: Partial<RenderActionMeasurement> = {},
): RenderActionMeasurement => ({
  label: "sort",
  renders: 10,
  commits: 2,
  widestCommit: 8,
  causes: causes(10),
  components: { Row: { renders: 10, causes: causes(10) } },
  wallMs: 25,
  longTasks: 1,
  longTaskMs: 60,
  ...overrides,
});

describe("census distributions", () => {
  test("keeps exact even and odd medians and full spread without mutating samples", () => {
    const values = [100, 2, 4, 1];
    expect(summarizeDistribution(values)).toEqual({
      median: 3,
      min: 1,
      max: 100,
    });
    expect(values).toEqual([100, 2, 4, 1]);
    expect(summarizeDistribution([7, 1, 2])).toEqual({
      median: 2,
      min: 1,
      max: 7,
    });
    expect(summarizeDistribution([0])).toEqual({ median: 0, min: 0, max: 0 });
    expect(summarizeDistribution([1, 2])).toEqual({
      median: 1.5,
      min: 1,
      max: 2,
    });
  });

  test("refuses an empty distribution instead of reporting a fabricated zero", () => {
    expect(() => summarizeDistribution([])).toThrow(
      "requires at least one sample",
    );
  });
});

describe("census aggregation", () => {
  test("isolates flow/action groups, ranks by median renders and preserves each metric", () => {
    const samples = [
      {
        flow: "table",
        measurements: [
          measurement({ renders: 100, wallMs: 200 }),
          measurement({ label: "scroll", renders: 5 }),
        ],
      },
      { flow: "matter", measurements: [measurement({ renders: 20 })] },
      {
        flow: "table",
        measurements: [
          measurement({
            renders: 2,
            commits: 6,
            widestCommit: 1,
            wallMs: 10,
            longTasks: 0,
            longTaskMs: 0,
            causes: causes(2),
          }),
          measurement({ label: "scroll", renders: 1 }),
        ],
      },
      {
        flow: "table",
        measurements: [
          measurement({
            renders: 10,
            commits: 4,
            widestCommit: 7,
            wallMs: 20,
            longTasks: 2,
            longTaskMs: 150,
            causes: causes(3),
          }),
          measurement({ label: "scroll", renders: 3 }),
        ],
      },
    ] satisfies CensusSample[];
    const summaries = summarizeCensus(samples);
    expect(summaries.map(({ flow, label }) => `${flow}/${label}`)).toEqual([
      "matter/sort",
      "table/sort",
      "table/scroll",
    ]);
    expect(summaries.at(1)).toMatchObject({
      samples: 3,
      renders: { median: 10, min: 2, max: 100 },
      commits: { median: 4, min: 2, max: 6 },
      widestCommit: { median: 7, min: 1, max: 8 },
      parentRenders: { median: 3, min: 2, max: 10 },
      wallMs: { median: 20, min: 10, max: 200 },
      longTasks: { median: 1, min: 0, max: 2 },
      longTaskMs: { median: 60, min: 0, max: 150 },
      causes: { parent: { median: 3, min: 2, max: 10 } },
    });
    expect(summarizeCensus(samples.toReversed())).toEqual(summaries);
  });

  test("includes absent component samples as zero and ranks the top ten with deterministic ties", () => {
    const components = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `Row${index.toString().padStart(2, "0")}`,
        { renders: 10, causes: causes(10) },
      ]),
    );
    const summaries = summarizeCensus([
      {
        flow: "table",
        measurements: [
          measurement({
            components: {
              ...components,
              Ephemeral: { renders: 1, causes: causes(1) },
            },
          }),
        ],
      },
      { flow: "table", measurements: [measurement({ components })] },
    ]);
    expect(summaries.at(0)?.components.map(({ name }) => name)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `Row${index.toString().padStart(2, "0")}`,
      ),
    );
    const absent = summarizeCensus([
      { flow: "table", measurements: [measurement()] },
      { flow: "table", measurements: [measurement({ components: {} })] },
    ])
      .at(0)
      ?.components.at(0);
    expect(absent).toEqual({
      name: "Row",
      renders: { median: 5, min: 0, max: 10 },
      causes: {
        mount: { median: 0, min: 0, max: 0 },
        props: { median: 0, min: 0, max: 0 },
        parent: { median: 5, min: 0, max: 10 },
        state: { median: 0, min: 0, max: 0 },
        context: { median: 0, min: 0, max: 0 },
      },
    });
  });

  test("refuses duplicate or missing actions so incomplete samples cannot improve the report", () => {
    expect(() =>
      summarizeCensus([
        { flow: "table", measurements: [measurement(), measurement()] },
      ]),
    ).toThrow("Duplicate census action");
    expect(() =>
      summarizeCensus([
        { flow: "table", measurements: [measurement()] },
        { flow: "table", measurements: [] },
      ]),
    ).toThrow("produced no action measurements");
    expect(() =>
      summarizeCensus([
        { flow: "table", measurements: [] },
        { flow: "table", measurements: [measurement()] },
      ]),
    ).toThrow("produced no action measurements");
    expect(() =>
      summarizeCensus([{ flow: "table", measurements: [] }]),
    ).toThrow("produced no action measurements");
    expect(() =>
      summarizeCensus([
        { flow: "table", measurements: [measurement()] },
        { flow: "table", measurements: [measurement({ label: "scroll" })] },
      ]),
    ).toThrow("action set changed");
    expect(summarizeCensus([])).toEqual([]);
  });

  test("summarizes stream deltas and each sample's renders per delta without inventing missing metrics", () => {
    const summaries = summarizeCensus([
      {
        flow: "chat",
        measurements: [
          measurement({ textDeltas: 2, rendersPerDelta: 5, renders: 10 }),
        ],
      },
      {
        flow: "chat",
        measurements: [
          measurement({ textDeltas: 4, rendersPerDelta: 2, renders: 8 }),
        ],
      },
      {
        flow: "chat",
        measurements: [
          measurement({ textDeltas: 10, rendersPerDelta: 3, renders: 30 }),
        ],
      },
    ]);
    expect(summaries.at(0)).toMatchObject({
      textDeltas: { median: 4, min: 2, max: 10 },
      rendersPerDelta: { median: 3, min: 2, max: 5 },
    });
    const report = formatCensusReport(summaries);
    expect(report).toContain("Text deltas: 4 (2–10).");
    expect(report).toContain("Renders per text delta: 3 (2–5).");
    const plain = summarizeCensus([
      { flow: "matter", measurements: [measurement()] },
    ]);
    expect(plain.at(0)?.textDeltas).toBeUndefined();
    expect(plain.at(0)?.rendersPerDelta).toBeUndefined();
    expect(formatCensusReport(plain)).not.toContain("Text deltas:");
  });

  test.each([{ textDeltas: 2 }, { rendersPerDelta: 2 }])(
    "refuses inconsistent stream metric coverage %j across samples",
    (overrides) => {
      expect(() =>
        summarizeCensus([
          { flow: "chat", measurements: [measurement(overrides)] },
          { flow: "chat", measurements: [measurement()] },
        ]),
      ).toThrow("metric presence changed");
    },
  );

  test("renders a ranked table and top components with escaped labels and every cause", () => {
    const report = formatCensusReport(
      summarizeCensus([
        {
          flow: "table|review",
          measurements: [measurement({ label: "sort\nascending" })],
        },
      ]),
    );
    expect(report).toContain(
      "| table\\|review / sort ascending | 1 | 10 (10–10) | 2 (2–2) | 8 (8–8) | 10 (10–10) | 25 (25–25) | 1 (1–1) | 60 (60–60) |",
    );
    expect(report).toContain(
      "| Row | 10 (10–10) | 0 (0–0) | 0 (0–0) | 10 (10–10) | 0 (0–0) | 0 (0–0) |",
    );
    expect(report).toContain(
      "Cause totals: mount 0 (0–0), props 0 (0–0), parent 10 (10–10), state 0 (0–0), context 0 (0–0).",
    );
  });
});
