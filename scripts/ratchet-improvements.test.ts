import { expect, test } from "bun:test";

import { assessMeasurements, type RatchetMetric } from "./ratchet";

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
