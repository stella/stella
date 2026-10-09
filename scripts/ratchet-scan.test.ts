import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assessMeasurements,
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
  }, 30_000);

  test("indirect exception budgets reject new and relocated owners", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-indirect-"));
    const metric =
      RATCHET_METRICS.find(
        ({ id }) => id === "outbound-indirect-access-exceptions",
      ) ?? panic("Indirect exception metric is missing");
    const owner = "apps/web/src/runtime.ts";
    const written = new Set<string>();
    const measure = (owners: readonly string[]) => {
      for (const file of written) {
        rmSync(path.join(root, file));
      }
      written.clear();
      for (const file of owners) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "void import(mod);");
        written.add(file);
      }
      return scanTree({ tree: openSourceTree(root), metrics: [metric] })
        .snapshot;
    };
    try {
      expect(metric.growth).toBe("shrink-only");
      expect(metric.perFile).toBe(true);
      const baseline = measure([owner]);
      expect(baseline[metric.id]).toEqual({ count: 1, files: { [owner]: 1 } });
      const assess = (owners: readonly string[]) =>
        assessMeasurements({
          current: measure(owners),
          baseline,
          metrics: [metric],
        });
      expect(assess([owner]).allowed).toBe(true);
      expect(assess([]).allowed).toBe(true);
      expect(assess(["apps/web/src/other.ts"]).allowed).toBe(false);
      expect(assess([owner, "apps/web/src/other.ts"]).allowed).toBe(false);
      expect(measure(["apps/web/src/fixture.test.ts"])[metric.id]).toEqual({
        count: 0,
        files: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counters parse through the shared per-file memo", async () => {
    const counters = await Bun.file(
      path.join(ROOT, "scripts/ratchet.ts"),
    ).text();
    expect(counters).not.toContain("ts.createSourceFile(");
  });

  test("a .ts generic arrow cannot hide subsequent audit directives", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-dialect-"));
    const file = "apps/api/src/handlers/generic.ts";
    try {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(
        path.join(root, file),
        [
          "const identity = <T>(value: T) => value;",
          "// audit: skip - after a generic arrow",
        ].join("\n"),
      );
      const metrics = RATCHET_METRICS.filter(
        ({ id }) => id === "audit-skip-directives",
      );
      expect(
        scanTree({ tree: openSourceTree(root), metrics }).snapshot[
          "audit-skip-directives"
        ]?.files,
      ).toEqual({ [file]: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
          role: "head",
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

  test("reuse preserves measurement roles and recomputes repository interactions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ratchet-role-reuse-"));
    const kept = "kept.ts";
    const added = "added.ts";
    let fileCalls = 0;
    let roleCalls = 0;
    let repoCalls = 0;
    const metrics = [
      {
        scope: "file",
        id: "independent",
        description: "Fixture occurrence count",
        include: ["*.ts"],
        exclude: () => false,
        count: (content: string) => {
          fileCalls += 1;
          return content.length;
        },
      },
      {
        scope: "file",
        id: "nonpositive",
        description: "Fixture excluded occurrence count",
        include: ["*.ts"],
        exclude: () => false,
        count: () => -1,
      },
      {
        scope: "file",
        id: "sensitive",
        description: "Fixture role count",
        measurement: "role-sensitive",
        include: ["*.ts"],
        exclude: () => false,
        count: (_content, { role }) => {
          roleCalls += 1;
          return role === "head" ? 1 : 2;
        },
      },
      {
        scope: "repo",
        id: "interactions",
        description: "Fixture file pair count",
        count: ({ root: directory }) => {
          repoCalls += 1;
          const size = [...new Bun.Glob("*.ts").scanSync(directory)].length;
          const count = size > 1 ? size : 0;
          return { count, files: count === 0 ? {} : { [kept]: count } };
        },
      },
    ] as const satisfies readonly RatchetMetric[];
    try {
      writeFileSync(path.join(root, kept), "x");
      const head = scanTree({ tree: openSourceTree(root), metrics });
      writeFileSync(path.join(root, added), "xx");
      const base = scanTree({
        tree: openSourceTree(root, { role: "base" }),
        metrics,
        previous: head,
      });
      expect(base.snapshot["nonpositive"]).toEqual({ count: 0, files: {} });
      expect(fileCalls).toBe(2);
      expect(roleCalls).toBe(3);
      expect(repoCalls).toBe(2);
      expect(base.snapshot["sensitive"]?.files).toEqual({
        [added]: 2,
        [kept]: 2,
      });
      expect(base.snapshot["interactions"]?.count).toBe(2);
      expect(base.snapshot).toEqual(
        scanTree({ tree: openSourceTree(root, { role: "base" }), metrics })
          .snapshot,
      );
      const tracked = scanTree({
        tree: openSourceTree(root, { trackedFiles: new Set([kept]) }),
        metrics: metrics.filter(({ scope }) => scope === "file"),
        previous: base,
      });
      expect(tracked.snapshot["independent"]?.files).toEqual({ [kept]: 1 });
      expect(tracked.snapshot["sensitive"]?.files).toEqual({ [kept]: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("outbound transport identities only shrink within each owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-outbound-owner-"));
  const file = "apps/api/src/handlers/transport-owner.ts";
  const metrics = RATCHET_METRICS.filter(
    ({ id }) => id === "api-legacy-outbound-transports",
  );
  try {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const measure = (source: string) => {
      writeFileSync(path.join(root, file), source);
      return scanTree({ tree: openSourceTree(root), metrics }).snapshot;
    };
    const baseline = measure("void fetch(url);");
    expect(
      assessMeasurements({
        current: measure("void fetch(url);"),
        baseline,
        metrics,
      }).allowed,
    ).toBe(true);
    expect(
      assessMeasurements({
        current: measure("export const ready = true;"),
        baseline,
        metrics,
      }).allowed,
    ).toBe(true);
    for (const module of ["undici", "node:http", "node:https"]) {
      const current = measure(`import * as transport from "${module}";`);
      expect(assessMeasurements({ current, baseline, metrics }).allowed).toBe(
        false,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
