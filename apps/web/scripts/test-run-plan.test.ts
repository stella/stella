import { describe, expect, test } from "bun:test";

import { planTestRuns } from "./test-run-plan";
import type { PathKind } from "./test-run-plan";

const ON_DISK: Readonly<Record<string, PathKind>> = {
  "src/features/avt/verdict.test.ts": "file",
  "./src/lib/format.test.ts": "file",
  "src/components/editor.dom.test.tsx": "file",
  "e2e/unit/network-metrics.test.ts": "file",
  "src/features/avt": "directory",
  scripts: "directory",
  "/repo/apps/web/e2e/unit/deferred-cleanup.test.ts": "file",
};

const DIRECTORY_FILES: Readonly<Record<string, readonly string[]>> = {
  "src/features/avt": [
    "src/features/avt/verdict.test.ts",
    "src/features/avt/claim-review.logic.test.ts",
  ],
};

const plan = (argv: readonly string[]) =>
  planTestRuns({
    argv,
    pathKind: (arg) => ON_DISK[arg] ?? "missing",
    testFilesIn: (directory) => DIRECTORY_FILES[directory] ?? [],
  });

describe("planTestRuns", () => {
  test("without paths, runs every kind and passes flags to each", () => {
    const runs = plan(["--", "--bail", "-t", "renders"]);

    expect(runs.map((run) => run.label)).toEqual(["unit", "dom", "e2e-unit"]);
    for (const run of runs) {
      expect(run.args.slice(-3)).toEqual(["--bail", "-t", "renders"]);
    }
  });

  test("with a file, runs only that file", () => {
    expect(plan(["src/features/avt/verdict.test.ts"])).toEqual([
      { label: "unit", args: ["./src/features/avt/verdict.test.ts"] },
    ]);
  });

  test("groups named files by kind with each kind's flags", () => {
    const runs = plan([
      "./src/lib/format.test.ts",
      "src/components/editor.dom.test.tsx",
      "e2e/unit/network-metrics.test.ts",
      "-t",
      "formats",
    ]);

    expect(runs).toEqual([
      { label: "unit", args: ["./src/lib/format.test.ts", "-t", "formats"] },
      {
        label: "dom",
        args: [
          "--isolate",
          "./src/components/editor.dom.test.tsx",
          "-t",
          "formats",
        ],
      },
      {
        label: "e2e-unit",
        args: [
          "--parallel=2",
          "./e2e/unit/network-metrics.test.ts",
          "-t",
          "formats",
        ],
      },
    ]);
  });

  test("expands a directory to the test files under it", () => {
    expect(plan(["src/features/avt"])).toEqual([
      {
        label: "unit",
        args: [
          "./src/features/avt/verdict.test.ts",
          "./src/features/avt/claim-review.logic.test.ts",
        ],
      },
    ]);
  });

  test("an option's value stays with the option even when it names a directory", () => {
    const runs = plan(["-t", "scripts"]);

    expect(runs.map((run) => run.label)).toEqual(["unit", "dom", "e2e-unit"]);
    for (const run of runs) {
      expect(run.args.slice(-2)).toEqual(["-t", "scripts"]);
    }
  });

  test("keeps absolute paths as given", () => {
    expect(plan(["/repo/apps/web/e2e/unit/deferred-cleanup.test.ts"])).toEqual([
      {
        label: "e2e-unit",
        args: [
          "--parallel=2",
          "/repo/apps/web/e2e/unit/deferred-cleanup.test.ts",
        ],
      },
    ]);
  });

  test("a directory without test files plans nothing to run", () => {
    expect(
      planTestRuns({
        argv: ["src/features/avt"],
        pathKind: () => "directory",
        testFilesIn: () => [],
      }),
    ).toEqual([]);
  });
});
