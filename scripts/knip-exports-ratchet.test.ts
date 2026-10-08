import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import { analyzeExports } from "./knip-exports-analysis";
import {
  collectIssueSymbols,
  diffSummaries,
  increasedWorkspaces,
  readBaseline,
  runWrite,
  runCheck,
  summarizeKnipReport,
  type Summary,
} from "./knip-exports-ratchet";

// One entry per file, shaped like knip's json reporter output.
const REPORT = {
  analyzedFiles: [
    "apps/web/src/lib/dates.ts",
    "apps/web/src/lib/citations.ts",
    "packages/ui/src/components/badge.tsx",
    "scripts/product-media.ts",
    "apps/api/src/server.ts",
  ],
  issues: [
    {
      file: "apps/web/src/lib/dates.ts",
      exports: [{ name: "formatDay", line: 4, col: 14 }],
      types: [{ name: "DayFormat", line: 9, col: 13 }],
    },
    {
      file: "apps/web/src/lib/citations.ts",
      exports: [{ name: "citationLabel", line: 2, col: 14 }],
    },
    {
      file: "packages/ui/src/components/badge.tsx",
      nsExports: [{ name: "badgeTone", line: 12, col: 7 }],
    },
    {
      file: "scripts/product-media.ts",
      exports: [{ name: "publishMedia", line: 30, col: 14 }],
    },
    // A file knip listed with no issue of a budgeted type.
    { file: "apps/api/src/server.ts", exports: [] },
  ],
};

const CURRENT = summarizeKnipReport(REPORT);

const statusOf = (
  current: Summary,
  baseline: Summary,
  workspace: string,
): string =>
  diffSummaries(current, baseline).find((diff) => diff.workspace === workspace)
    ?.status ?? "missing";

test("counts issues per workspace and per file", () => {
  expect(CURRENT).toEqual({
    ".": {
      count: 1,
      analyzedFiles: 1,
      files: { "scripts/product-media.ts": 1 },
    },
    "apps/api": { count: 0, analyzedFiles: 1, files: {} },
    "apps/web": {
      count: 3,
      analyzedFiles: 2,
      files: {
        "apps/web/src/lib/citations.ts": 1,
        "apps/web/src/lib/dates.ts": 2,
      },
    },
    "packages/ui": {
      count: 1,
      analyzedFiles: 1,
      files: { "packages/ui/src/components/badge.tsx": 1 },
    },
  });
});

test("an unchanged count passes", () => {
  expect(
    diffSummaries(CURRENT, CURRENT).every((diff) => diff.status === "ok"),
  ).toBe(true);
});

test("a rise regresses and names the file", () => {
  const baseline: Summary = {
    ...CURRENT,
    "apps/web": {
      count: 2,
      analyzedFiles: 2,
      files: {
        "apps/web/src/lib/citations.ts": 1,
        "apps/web/src/lib/dates.ts": 1,
      },
    },
  };

  const web = diffSummaries(CURRENT, baseline).find(
    (diff) => diff.workspace === "apps/web",
  );
  expect(web?.status).toBe("regressed");
  expect(web?.regressedFiles).toEqual([
    { file: "apps/web/src/lib/dates.ts", from: 1, to: 2 },
  ]);
});

test("a fall reports a drop", () => {
  const baseline: Summary = {
    ...CURRENT,
    "packages/ui": {
      count: 4,
      analyzedFiles: 1,
      files: { "packages/ui/src/components/badge.tsx": 4 },
    },
  };

  expect(statusOf(CURRENT, baseline, "packages/ui")).toBe("dropped");
});

test("a workspace with no baseline entry regresses on its first issue", () => {
  const baseline: Summary = { ...CURRENT };
  delete baseline["packages/ui"];

  const diff = diffSummaries(CURRENT, baseline).find(
    (entry) => entry.workspace === "packages/ui",
  );
  expect(diff?.status).toBe("regressed");
  expect(diff?.baseline).toBe(0);
  expect(diff?.current).toBe(1);
});

test("labels each symbol with the issue type it was reported under", () => {
  expect(collectIssueSymbols(REPORT)).toEqual({
    "apps/web/src/lib/dates.ts": ["formatDay (exports)", "DayFormat (types)"],
    "apps/web/src/lib/citations.ts": ["citationLabel (exports)"],
    "packages/ui/src/components/badge.tsx": ["badgeTone (nsExports)"],
    "scripts/product-media.ts": ["publishMedia (exports)"],
  });
});

test("a write that would raise a workspace names it", () => {
  const baseline: Summary = {
    ...CURRENT,
    "apps/web": {
      count: 2,
      analyzedFiles: 2,
      files: {
        "apps/web/src/lib/citations.ts": 1,
        "apps/web/src/lib/dates.ts": 1,
      },
    },
  };

  expect(
    increasedWorkspaces(CURRENT, baseline).map((d) => d.workspace),
  ).toEqual(["apps/web"]);
  expect(increasedWorkspaces(CURRENT, CURRENT)).toEqual([]);
});

test("an empty analysis report fails coverage for every baseline workspace", () => {
  const empty = summarizeKnipReport({ analyzedFiles: [], issues: [] });
  const diffs = diffSummaries(empty, CURRENT);
  expect(diffs.length).toBe(Object.keys(CURRENT).length);
  expect(diffs.every(({ status }) => status === "coverage-dropped")).toBe(true);
});

test("a missing workspace fails even when its issue budget is zero", () => {
  const current = { ...CURRENT };
  delete current["apps/api"];
  expect(statusOf(current, CURRENT, "apps/api")).toBe("coverage-dropped");
});

test("zero analyzed files fail even with a zero baseline budget", () => {
  expect(
    statusOf(
      { "apps/api": { count: 0, analyzedFiles: 0, files: {} } },
      CURRENT,
      "apps/api",
    ),
  ).toBe("coverage-dropped");
});

test.each([0, 1, 4, 5, 6, 10])(
  "enforces the 50 percent analysis floor at %s files",
  (analyzedFiles) => {
    const baseline = { "apps/api": { count: 0, analyzedFiles: 10, files: {} } };
    const current = { "apps/api": { count: 0, analyzedFiles, files: {} } };
    expect(statusOf(current, baseline, "apps/api")).toBe(
      analyzedFiles < 5 ? "coverage-dropped" : "ok",
    );
  },
);

test("an export decrease with retained analysis passes", () => {
  const current = summarizeKnipReport({ ...REPORT, issues: [] });
  expect(
    diffSummaries(current, CURRENT).every(
      ({ status }) => status === "dropped" || status === "ok",
    ),
  ).toBe(true);
});

test("writing a baseline round-trips analyzed coverage and export budgets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "knip-baseline-"));
  const baselinePath = path.join(root, "baseline.json");
  try {
    expect(runWrite({ report: REPORT, baselinePath })).toBe(0);
    expect(readBaseline({ baselinePath })).toEqual(CURRENT);
    const original = readFileSync(baselinePath, "utf-8");
    expect(runCheck({ report: REPORT, baselinePath })).toBe(0);
    expect(runCheck({ report: { ...REPORT, issues: [] }, baselinePath })).toBe(
      0,
    );
    expect(
      runCheck({ report: { analyzedFiles: [], issues: [] }, baselinePath }),
    ).toBe(1);
    expect(
      runCheck({
        report: { analyzedFiles: ["apps/web/src/lib/dates.ts"], issues: [] },
        baselinePath,
      }),
    ).toBe(1);
    expect(runWrite({ report: REPORT, baselinePath })).toBe(0);
    expect(readFileSync(baselinePath, "utf-8")).toBe(original);
    expect(
      runWrite({ report: { analyzedFiles: [], issues: [] }, baselinePath }),
    ).toBe(1);
    expect(readFileSync(baselinePath, "utf-8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writing refreshes analysis coverage while preserving the decrease-only budget", () => {
  const root = mkdtempSync(path.join(tmpdir(), "knip-refresh-"));
  const baselinePath = path.join(root, "baseline.json");
  try {
    expect(runWrite({ report: REPORT, baselinePath })).toBe(0);
    const reduced = {
      analyzedFiles: ["apps/web/src/lib/dates.ts"],
      issues: [],
    };
    expect(runWrite({ report: reduced, baselinePath })).toBe(0);
    expect(readBaseline({ baselinePath })).toEqual({
      "apps/web": { count: 0, analyzedFiles: 1, files: {} },
    });
    expect(runWrite({ report: REPORT, baselinePath })).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the analysis producer retains clean source files and reports empty entry coverage", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "knip-analysis-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", private: true }),
    );
    writeFileSync(path.join(root, "entry.ts"), "export {};\n");
    writeFileSync(
      path.join(root, "knip.json"),
      JSON.stringify({ entry: ["entry.ts"], project: ["*.ts"] }),
    );
    const report = await analyzeExports(root);
    expect(report.analyzedFiles).toEqual(["entry.ts"]);
    expect(report.issues).toEqual([]);
    const baseline = summarizeKnipReport(report);
    writeFileSync(
      path.join(root, "entry.ts"),
      'import { used } from "./module"; console.log(used);\n',
    );
    writeFileSync(
      path.join(root, "module.ts"),
      "export const used = 1; export const unused = 2; export type Unused = string;\n",
    );
    const withIssues = await analyzeExports(root);
    expect(withIssues.analyzedFiles.toSorted()).toEqual([
      "entry.ts",
      "module.ts",
    ]);
    expect(collectIssueSymbols(withIssues)).toEqual({
      "module.ts": ["unused (exports)", "Unused (types)"],
    });
    expect(summarizeKnipReport(withIssues)["."]?.count).toBe(2);
    writeFileSync(
      path.join(root, "knip.json"),
      JSON.stringify({ entry: ["absent.ts"], project: ["*.ts"] }),
    );
    const empty = await analyzeExports(root);
    expect(empty.analyzedFiles).toEqual([]);
    expect(empty.issues).toEqual([]);
    expect(statusOf(summarizeKnipReport(empty), baseline, ".")).toBe(
      "coverage-dropped",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knip coverage accepts precisely positive counts at or above half the baseline", () => {
  assertProperty(
    "knip coverage accepts precisely positive counts at or above half the baseline",
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      (baselineCount, currentCount) => {
        const baseline = {
          ".": { count: 0, analyzedFiles: baselineCount, files: {} },
        };
        const current = {
          ".": { count: 0, analyzedFiles: currentCount, files: {} },
        };
        expect(statusOf(current, baseline, ".") === "ok").toBe(
          currentCount > 0 && currentCount * 2 >= baselineCount,
        );
      },
    ),
  );
});

test("check mode refuses a baseline without analysis coverage and write upgrades it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "knip-schema-"));
  const baselinePath = path.join(root, "baseline.json");
  try {
    writeFileSync(
      baselinePath,
      JSON.stringify({
        "apps/web": { count: 3, files: { "apps/web/src/lib/dates.ts": 3 } },
      }),
    );
    // With no report supplied, baseline validation must precede any Knip run.
    expect(runCheck({ baselinePath })).toBe(1);
    expect(() => readBaseline({ baselinePath })).toThrow(
      "positive analyzedFiles count; run",
    );
    expect(runWrite({ report: { ...REPORT, issues: [] }, baselinePath })).toBe(
      0,
    );
    expect(readBaseline({ baselinePath })).toEqual(
      summarizeKnipReport({ ...REPORT, issues: [] }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
