import { expect, test } from "bun:test";

import {
  checkRegressions,
  collectIssueSymbols,
  diffSummaries,
  increasedWorkspaces,
  summarizeKnipReport,
  type Summary,
} from "./knip-exports-ratchet";

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
