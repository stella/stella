import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assessImprovementsOnly,
  assessImprovementWrite,
  writeImprovementBaseline,
  type RatchetMetric,
} from "./ratchet";

const firstMetric = {
  id: "first",
  scope: "repo",
  description: "first",
  count: () => ({ count: 0, files: {} }),
} satisfies RatchetMetric;

const secondMetric = {
  id: "second",
  scope: "repo",
  description: "second",
  count: () => ({ count: 0, files: {} }),
} satisfies RatchetMetric;

const metrics = [firstMetric, secondMetric] satisfies readonly RatchetMetric[];

const snapshot = (count: number, files: Record<string, number>) => ({
  count,
  files,
});

const withBaselineFile = (run: (baselinePath: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ratchet-improvements-"));
  const baselinePath = path.join(directory, "baseline.json");
  try {
    run(baselinePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("improvements-only ratchet writes", () => {
  test("writes a baseline with a lower count", () => {
    withBaselineFile((baselinePath) => {
      const existing = JSON.stringify({ first: snapshot(3, { "a.ts": 3 }) });
      const candidate = JSON.stringify({ first: snapshot(2, { "a.ts": 2 }) });
      writeFileSync(baselinePath, existing);
      const assessment = assessImprovementsOnly({
        current: { first: snapshot(2, { "a.ts": 2 }) },
        baseline: { first: snapshot(3, { "a.ts": 3 }) },
        metrics: [firstMetric],
      });

      expect(
        writeImprovementBaseline({ assessment, candidate, path: baselinePath }),
      ).toBe("written");
      expect(readFileSync(baselinePath, "utf-8")).toBe(candidate);
    });
  });

  test("refuses an increase and leaves the baseline bytes unchanged", () => {
    withBaselineFile((baselinePath) => {
      const existing = JSON.stringify({ first: snapshot(2, { "a.ts": 2 }) });
      writeFileSync(baselinePath, existing);
      const assessment = assessImprovementsOnly({
        current: { first: snapshot(3, { "a.ts": 3 }) },
        baseline: { first: snapshot(2, { "a.ts": 2 }) },
        metrics: [firstMetric],
      });

      expect(
        writeImprovementBaseline({
          assessment,
          candidate: "regressed candidate",
          path: baselinePath,
        }),
      ).toBe("refused");
      expect(readFileSync(baselinePath, "utf-8")).toBe(existing);
    });
  });

  test("refuses a mixed change and leaves the baseline bytes unchanged", () => {
    withBaselineFile((baselinePath) => {
      const existing = JSON.stringify({
        first: snapshot(3, { "a.ts": 3 }),
        second: snapshot(2, { "b.ts": 2 }),
      });
      writeFileSync(baselinePath, existing);
      const assessment = assessImprovementsOnly({
        current: {
          first: snapshot(2, { "a.ts": 2 }),
          second: snapshot(3, { "b.ts": 3 }),
        },
        baseline: {
          first: snapshot(3, { "a.ts": 3 }),
          second: snapshot(2, { "b.ts": 2 }),
        },
        metrics,
      });

      expect(
        writeImprovementBaseline({
          assessment,
          candidate: "mixed candidate",
          path: baselinePath,
        }),
      ).toBe("refused");
      expect(readFileSync(baselinePath, "utf-8")).toBe(existing);
    });
  });

  test("refuses a regressed delta candidate despite an improved current tree", () => {
    const assessment = assessImprovementWrite({
      current: { first: snapshot(1, { "a.ts": 1 }) },
      candidate: { first: snapshot(3, { "a.ts": 3 }) },
      baseline: { first: snapshot(2, { "a.ts": 2 }) },
      metrics: [firstMetric],
    });

    expect(assessment.allowed).toBe(false);
  });

  test("catches per-file increases offset by a decrease elsewhere", () => {
    const perFileMetric = {
      id: "per-file",
      scope: "file",
      description: "per file",
      include: ["**/*.ts"],
      exclude: () => false,
      count: () => 0,
      perFile: true,
    } satisfies RatchetMetric;
    const assessment = assessImprovementsOnly({
      current: { "per-file": snapshot(4, { "a.ts": 1, "b.ts": 3 }) },
      baseline: { "per-file": snapshot(4, { "a.ts": 2, "b.ts": 2 }) },
      metrics: [perFileMetric],
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.diffs[0]?.status).toBe("regressed");
    expect(assessment.diffs[0]?.regressedFiles).toEqual([
      { file: "b.ts", from: 2, to: 3 },
    ]);
  });

  test("equal metric counts do not rewrite baseline layout", () => {
    withBaselineFile((baselinePath) => {
      const existing = JSON.stringify({ first: snapshot(3, { "a.ts": 3 }) });
      writeFileSync(baselinePath, existing);
      const assessment = assessImprovementsOnly({
        current: { first: snapshot(3, { "b.ts": 3 }) },
        baseline: { first: snapshot(3, { "a.ts": 3 }) },
        metrics: [firstMetric],
      });
      expect(
        writeImprovementBaseline({
          assessment,
          candidate: "different layout",
          path: baselinePath,
        }),
      ).toBe("unchanged");
      expect(readFileSync(baselinePath, "utf-8")).toBe(existing);
    });
  });

  test("an unchanged candidate succeeds without rewriting baseline bytes", () => {
    withBaselineFile((baselinePath) => {
      const existing = JSON.stringify({ first: snapshot(3, { "a.ts": 3 }) });
      writeFileSync(baselinePath, existing);
      const assessment = assessImprovementsOnly({
        current: { first: snapshot(3, { "a.ts": 3 }) },
        baseline: { first: snapshot(3, { "a.ts": 3 }) },
        metrics: [firstMetric],
      });

      expect(
        writeImprovementBaseline({
          assessment,
          candidate: existing,
          path: baselinePath,
        }),
      ).toBe("unchanged");
      expect(readFileSync(baselinePath, "utf-8")).toBe(existing);
    });
  });
});
