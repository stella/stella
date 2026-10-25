import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  assessMeasurements,
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
