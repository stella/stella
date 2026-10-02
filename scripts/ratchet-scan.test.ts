import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  openSourceTree,
  RATCHET_METRICS,
  type RatchetMetric,
  scanTree,
  selectMetricFiles,
} from "./ratchet";

const ROOT = path.resolve(import.meta.dir, "..");

// What a metric scanned before the walk was shared: its own globs, walked
// fresh, each match once, minus its excludes.
const ownSelection = (
  metric: Extract<RatchetMetric, { scope: "file" }>,
): string[] => {
  const seen = new Set<string>();
  for (const glob of metric.include) {
    for (const rel of new Bun.Glob(glob).scanSync(ROOT)) {
      seen.add(rel);
    }
  }
  return [...seen].filter((rel) => !metric.exclude(rel)).toSorted();
};

describe("shared ratchet scan", () => {
  test("every file metric scans exactly the files its own globs select", () => {
    const tree = openSourceTree(ROOT);
    for (const metric of RATCHET_METRICS) {
      if (metric.scope !== "file") {
        continue;
      }
      expect({
        id: metric.id,
        files: selectMetricFiles(tree, metric).toSorted(),
      }).toEqual({ id: metric.id, files: ownSelection(metric) });
    }
  });

  test("counters parse through the shared per-file memo", async () => {
    const counters = await Bun.file(
      path.join(ROOT, "scripts/ratchet.ts"),
    ).text();
    expect(counters).not.toContain("ts.createSourceFile(");
  });

  test("an earlier scan's counts carry over only for identical text", () => {
    const metrics = RATCHET_METRICS.filter(({ id }) => id === "as-casts");
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-scan-"));
    const source = (relative: string, contents: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), contents);
    };
    const kept = "apps/api/src/kept.ts";
    const edited = "apps/api/src/edited.ts";
    try {
      source(kept, "export const a = b as A;\n");
      source(edited, "export const c = d as C;\n");
      const first = scanTree({ tree: openSourceTree(root), metrics });

      source(edited, "export const c = d as C;\nexport const e = f as E;\n");
      const fresh = scanTree({ tree: openSourceTree(root), metrics });
      const reused = scanTree({
        tree: openSourceTree(root),
        metrics,
        previous: first,
      });
      expect(reused.snapshot).toEqual(fresh.snapshot);
      expect(fresh.snapshot["as-casts"]?.files).toEqual({
        [edited]: 2,
        [kept]: 1,
      });

      // Counts recorded for the same text are trusted as they stand, which is
      // what makes them reusable; counts for other text never are.
      const keptContent =
        first.files.get(kept)?.content ?? panic("kept file was not scanned");
      const poisoned = scanTree({
        tree: openSourceTree(root),
        metrics,
        previous: {
          snapshot: {},
          files: new Map([
            [
              kept,
              { content: keptContent, counts: new Map([["as-casts", 5]]) },
            ],
            [edited, { content: "", counts: new Map([["as-casts", 9]]) }],
          ]),
        },
      });
      expect(poisoned.snapshot["as-casts"]?.files).toEqual({
        [edited]: 2,
        [kept]: 5,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
