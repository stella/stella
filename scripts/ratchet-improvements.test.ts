import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  assessMeasurements,
  checkMetricDeadlines,
  metricDeadlineMode,
  RATCHET_METRICS,
  type RatchetMetric,
} from "./ratchet";

const metric = {
  id: "fixture",
  scope: "file",
  description: "fixture",
  include: [],
  exclude: () => false,
  count: () => 0,
  perFile: true,
} satisfies RatchetMetric;
const snapshot = (files: Record<string, number>) => ({
  count: Object.values(files).reduce((total, count) => total + count, 0),
  files,
});

test("raw transaction ceilings tighten as the supplied clock advances", () => {
  const raw =
    RATCHET_METRICS.find(({ id }) => id === "raw-api-transaction-boundaries") ??
    panic("Raw transaction metric is missing");
  const ceilings =
    raw.datedCeilings ?? panic("Raw transaction deadlines are missing");
  const check = (count: number, now: Date) =>
    checkMetricDeadlines({
      mode: "main",
      current: {
        [raw.id]: snapshot(
          count === 0 ? {} : { "apps/api/src/legacy.ts": count },
        ),
      },
      metrics: [raw],
      now,
    }).errors;
  expect(check(257, new Date("2026-10-30T00:00:00.000Z"))).toEqual([]);
  for (const ceiling of ceilings) {
    const now = new Date(ceiling.effectiveAt);
    expect(check(ceiling.maximum, now)).toEqual([]);
    expect(check(ceiling.maximum + 1, now)).toContainEqual(
      expect.stringContaining(`exceeds dated ceiling ${ceiling.maximum}`),
    );
  }
  expect(check(1, new Date("2026-12-12T00:00:00.000Z"))).toHaveLength(1);
  expect(check(0, new Date("2026-12-12T00:00:00.000Z"))).toEqual([]);
});

test("meeting a dated total does not permit per-file transaction debt growth", () => {
  const raw =
    RATCHET_METRICS.find(({ id }) => id === "raw-api-transaction-boundaries") ??
    panic("Raw transaction metric is missing");
  const baseline = { [raw.id]: snapshot({ "apps/api/src/legacy.ts": 257 }) };
  const current = { [raw.id]: snapshot({ "apps/api/src/new.ts": 100 }) };
  expect(
    checkMetricDeadlines({
      mode: "main",
      current,
      metrics: [raw],
      now: new Date("2026-11-27T00:00:00.000Z"),
    }).errors,
  ).toEqual([]);
  expect(
    assessMeasurements({ current, baseline, metrics: [raw] }).allowed,
  ).toBe(false);
});

test("dated ceilings reject an invalid or weakening schedule", () => {
  const check = (datedCeilings: NonNullable<RatchetMetric["datedCeilings"]>) =>
    checkMetricDeadlines({
      mode: "main",
      current: { fixture: snapshot({}) },
      metrics: [{ ...metric, datedCeilings }],
      now: new Date("2026-10-30T00:00:00.000Z"),
    });
  for (const datedCeilings of [
    [{ effectiveAt: "invalid", maximum: 1 }],
    [{ effectiveAt: "2026-11-13T00:00:00.000Z", maximum: -1 }],
    [{ effectiveAt: "2026-11-13T00:00:00.000Z", maximum: 1.5 }],
    [
      { effectiveAt: "2026-11-13T00:00:00.000Z", maximum: 100 },
      { effectiveAt: "2026-11-27T00:00:00.000Z", maximum: 200 },
    ],
    [
      { effectiveAt: "2026-11-13T00:00:00.000Z", maximum: 100 },
      { effectiveAt: "2026-11-13T00:00:00.000Z", maximum: 0 },
    ],
  ]) {
    expect(() => check(datedCeilings)).toThrow(
      "dated ceilings must have increasing dates",
    );
  }
  expect(() =>
    checkMetricDeadlines({
      mode: "main",
      current: { fixture: snapshot({}) },
      metrics: [metric],
      now: new Date(Number.NaN),
    }),
  ).toThrow("Ratchet deadline clock must be a valid instant");
});

test("only main push and schedule events use the standing deadline gate", () => {
  for (const event of [
    { eventName: undefined, ref: undefined, expected: "change" },
    { eventName: "pull_request", ref: "refs/heads/main", expected: "change" },
    {
      eventName: "merge_group",
      ref: "refs/heads/gh-readonly-queue/main/pr-1",
      expected: "change",
    },
    { eventName: "push", ref: "refs/heads/feature", expected: "change" },
    { eventName: "push", ref: "refs/heads/main", expected: "main" },
    { eventName: "schedule", ref: undefined, expected: "main" },
  ]) {
    expect(metricDeadlineMode(event)).toBe(event.expected);
  }
});

test("unrelated changes warn about overdue debt and its next checkpoint", () => {
  const raw =
    RATCHET_METRICS.find(({ id }) => id === "raw-api-transaction-boundaries") ??
    panic("Raw transaction metric is missing");
  const current = { [raw.id]: snapshot({ "apps/api/src/legacy.ts": 257 }) };
  const check = (now: Date) =>
    checkMetricDeadlines({
      mode: "change",
      current,
      baseline: current,
      changedFiles: new Set(["apps/web/src/appearance.ts"]),
      metrics: [raw],
      now,
    });
  const result = check(new Date("2026-11-14T00:00:00.000Z"));
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([
    expect.stringContaining("257 exceeds dated ceiling 200"),
  ]);
  expect(result.warnings.at(0)).toContain(
    "next deadline 2026-11-27T00:00:00.000Z (maximum 100)",
  );
  expect(check(new Date("2026-12-12T00:00:00.000Z")).warnings.at(0)).toContain(
    "next deadline none",
  );
});

test("changes above a ceiling fail on raw growth or touching a base or head raw-site file", () => {
  const raw =
    RATCHET_METRICS.find(({ id }) => id === "raw-api-transaction-boundaries") ??
    panic("Raw transaction metric is missing");
  const legacy = "apps/api/src/legacy.ts";
  const remaining = "apps/api/src/remaining.ts";
  const baseline = { [raw.id]: snapshot({ [legacy]: 1, [remaining]: 256 }) };
  for (const change of [
    {
      snapshot: snapshot({ [legacy]: 1, [remaining]: 257 }),
      changedFiles: new Set<string>(),
    },
    {
      snapshot: snapshot({ [legacy]: 1, [remaining]: 256 }),
      changedFiles: new Set([legacy]),
    },
    {
      snapshot: snapshot({ [remaining]: 256 }),
      changedFiles: new Set([legacy]),
    },
  ]) {
    const result = checkMetricDeadlines({
      mode: "change",
      current: { [raw.id]: change.snapshot },
      baseline,
      changedFiles: change.changedFiles,
      metrics: [raw],
      now: new Date("2026-11-14T00:00:00.000Z"),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  }
});

test("per-file ceilings reject relocated violations even when totals decrease", () => {
  for (let base = 1; base < 12; base += 1) {
    const assess = (files: Record<string, number>) =>
      assessMeasurements({
        current: { fixture: snapshot(files) },
        baseline: { fixture: snapshot({ "a.ts": base }) },
        metrics: [metric],
      });
    expect(assess({ "a.ts": base }).allowed).toBe(true);
    expect(assess({ "a.ts": base - 1 }).allowed).toBe(true);
    expect(assess({ "a.ts": base + 1 }).allowed).toBe(false);
    expect(assess({ "b.ts": 1 }).allowed).toBe(false);
  }
});

const broaderGuards = [
  {
    id: "raw-user-avatar-primitive",
    source:
      'export * from "@stll/ui/avatar";\nconst lazy = import("@stll/ui/components/avatar");\nconst loaded = require("@stll/ui/avatar");',
    expected: 3,
    file: "apps/web/src/components/example.tsx",
  },
  {
    id: "shadowed-user-name-helpers",
    source:
      'function render() { const getInitials = () => "A"; function getDisplayName() { return "Name"; } }',
    expected: 2,
    file: "apps/web/src/components/example.tsx",
  },
  {
    id: "entity-kind-glyph-adhoc",
    source: "const glyph = icons.FolderIcon;",
    expected: 1,
    file: "apps/web/src/components/example.tsx",
  },
  {
    id: "ad-hoc-relative-time-formatting",
    source: 'const options = { dateStyle: "full", timeStyle: "medium" };',
    expected: 1,
    file: "apps/web/src/components/example.tsx",
  },
  {
    id: "inline-timestamp-cursor-sql",
    source: 'const format = `yyyy-mm-dd"t"hh24:mi:ss.us`;',
    expected: 1,
    file: "apps/api/src/handlers/example.ts",
  },
];

test.each(broaderGuards)(
  "retains the broader $id guard",
  ({ id, source, expected, file }) => {
    const guard =
      RATCHET_METRICS.find((entry) => entry.id === id) ??
      panic(`Missing broader guard: ${id}`);
    if (guard.scope !== "file") {
      panic(`Expected a file guard: ${id}`);
    }
    expect(guard.exclude(file)).toBe(false);
    expect(guard.count(source, { file, role: "head" })).toBe(expected);
  },
);

test("raw numeric coercions count non-literal conversions and ignore syntax noise", () => {
  const guard =
    RATCHET_METRICS.find(({ id }) => id === "raw-numeric-coercions") ??
    panic("Missing raw numeric coercion metric");
  if (guard.scope !== "file") {
    panic("Expected a file metric for raw numeric coercions");
  }
  const file = "packages/example/src/coercions.ts";
  expect(guard.growth).toBe("shrink-only");
  expect(guard.perFile).toBe(true);
  expect(guard.exclude(file)).toBe(false);
  expect(
    guard.count(
      [
        "Number(amount)",
        "parseInt(text, 10)",
        "parseFloat(decimal)",
        "Number.parseInt(text, 10)",
        "Number.parseFloat(decimal)",
        'Number("12")',
        "Number(12)",
        "Number(((12)))",
        "Number(12n)",
        "Number(true)",
        "Number(null)",
        "Number(-12)",
        "Number(+12n)",
        "schema.Number(amount)",
        "other.parseInt(text)",
        "// Number(amount) and parseInt(text)",
        'const example = "Number(amount)";',
      ].join("\n"),
      { file, role: "head" },
    ),
  ).toBe(5);

  for (const excluded of [
    "apps/web/src/coercions.test.ts",
    "packages/example/src/coercions.gen.ts",
    "packages/example/src/tests/coercions.ts",
    "packages/example/src/scripts/coercions.ts",
    "packages/example/src/evals/coercions.ts",
    "packages/agent-input/src/numeric-token.ts",
  ]) {
    expect(guard.exclude(excluded)).toBe(true);
  }

  const baseline = { count: 0, files: {} };
  const current = { count: 1, files: { [file]: 1 } };
  expect(
    assessMeasurements({
      current: { [guard.id]: current },
      baseline: { [guard.id]: baseline },
      metrics: [guard],
    }).allowed,
  ).toBe(false);
});
