import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { compareCodeUnit } from "@stll/collation";

import {
  checkRegressions,
  collectIssueSymbols,
  diffSummaries,
  formatFileDeltas,
  increasedWorkspaces,
  runKnipExportsRatchet,
  summarizeKnipReport,
  type Summary,
} from "./knip-exports-ratchet";
import {
  generatedKnipConfigPaths,
  KNIP_GENERATED_ENTRY_FILES,
  validateKnipGeneratedEntries,
} from "./knip-generated-entries";

// One entry per file, shaped like knip's json reporter output.
const REPORT = {
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

test("refuses to run when a generated knip entry is missing", () => {
  const error = validateKnipGeneratedEntries("/fixture", () => false);

  expect(error?._tag).toBe("KnipGeneratedEntriesMissingError");
  expect(error?.missingFiles).toEqual(KNIP_GENERATED_ENTRY_FILES);
  expect(error?.message).toContain("apps/web/src/routeTree.gen.ts");
  expect(error?.message).toContain("bun run generate");

  let modeRuns = 0;
  const skippedMode = () => {
    modeRuns += 1;
    return 0;
  };
  const messages: string[] = [];
  const status = runKnipExportsRatchet({
    args: ["bun", "scripts/knip-exports-ratchet.ts", "--check"],
    repoRoot: "/fixture",
    fileExists: () => false,
    runners: { report: skippedMode, write: skippedMode, check: skippedMode },
    reportError: (message) => {
      messages.push(message);
    },
  });

  expect(status).toBe(1);
  expect(modeRuns).toBe(0);
  expect(messages).toEqual([
    `KnipGeneratedEntriesMissingError: ${error?.message ?? ""}`,
  ]);
});

test("generated knip entry census matches the generator-owned list", () => {
  expect(generatedKnipConfigPaths(readFileSync("knip.json", "utf-8"))).toEqual(
    KNIP_GENERATED_ENTRY_FILES.toSorted(compareCodeUnit),
  );
});

const statusOf = (
  current: Summary,
  baseline: Summary,
  workspace: string,
): string =>
  diffSummaries(current, baseline).find((diff) => diff.workspace === workspace)
    ?.status ?? "missing";

test("counts issues per workspace and per file", () => {
  expect(CURRENT).toEqual({
    ".": { count: 1, files: { "scripts/product-media.ts": 1 } },
    "apps/web": {
      count: 3,
      files: {
        "apps/web/src/lib/citations.ts": 1,
        "apps/web/src/lib/dates.ts": 2,
      },
    },
    "packages/ui": {
      count: 1,
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

test("check fails on a new unused export even when the workspace total has slack", () => {
  // The branch's baseline predates a drop elsewhere, so the total still fits.
  const baseline: Summary = {
    ...CURRENT,
    "apps/web": {
      count: 5,
      files: {
        "apps/web/src/lib/dates.ts": 2,
        "apps/web/src/lib/retired.ts": 3,
      },
    },
  };

  expect(statusOf(CURRENT, baseline, "apps/web")).toBe("dropped");
  expect(checkRegressions(CURRENT, baseline)).toEqual([
    {
      workspace: "apps/web",
      status: "dropped",
      current: 3,
      baseline: 5,
      changedFiles: [
        { file: "apps/web/src/lib/citations.ts", from: 0, to: 1 },
        { file: "apps/web/src/lib/retired.ts", from: 3, to: 0 },
      ],
      regressedFiles: [
        { file: "apps/web/src/lib/citations.ts", from: 0, to: 1 },
      ],
    },
  ]);
});

test("a move between files fails the check but records without a flag", () => {
  const baseline: Summary = {
    ...CURRENT,
    "apps/web": {
      count: 3,
      files: {
        "apps/web/src/lib/dates.ts": 2,
        "apps/web/src/lib/old-citations.ts": 1,
      },
    },
  };

  expect(
    checkRegressions(CURRENT, baseline).map((diff) => diff.workspace),
  ).toEqual(["apps/web"]);
  expect(increasedWorkspaces(CURRENT, baseline)).toEqual([]);
});

test("check passes when no file rose", () => {
  expect(checkRegressions(CURRENT, CURRENT)).toEqual([]);
});

test("diff diagnostics name reductions, removed files and increases in sorted order", () => {
  const diffs = diffSummaries(
    {
      "apps/web": {
        count: 4,
        files: {
          "apps/web/stable.ts": 1,
          "apps/web/new.ts": 1,
          "apps/web/changed.ts": 2,
        },
      },
    },
    {
      "apps/web": {
        count: 6,
        files: {
          "apps/web/stable.ts": 1,
          "apps/web/removed.ts": 2,
          "apps/web/changed.ts": 3,
        },
      },
    },
  );
  const diff = diffs.at(0);
  expect(diff).toBeDefined();
  if (diff === undefined) {
    throw new TypeError("Expected workspace diff");
  }
  expect(formatFileDeltas(diff.changedFiles)).toBe(
    "      apps/web/changed.ts: 3 -> 2\n" +
      "      apps/web/new.ts: 0 -> 1\n" +
      "      apps/web/removed.ts: 2 -> 0",
  );
  expect(formatFileDeltas([])).toBe("");
});
