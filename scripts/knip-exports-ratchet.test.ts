import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { compareCodeUnit } from "@stll/collation";

import {
  collectIssueSymbols,
  runKnipExportsRatchet,
  summarizeKnipReport,
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
    runners: { report: skippedMode, check: skippedMode },
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

test("labels each symbol with the issue type it was reported under", () => {
  expect(collectIssueSymbols(REPORT)).toEqual({
    "apps/web/src/lib/dates.ts": ["formatDay (exports)", "DayFormat (types)"],
    "apps/web/src/lib/citations.ts": ["citationLabel (exports)"],
    "packages/ui/src/components/badge.tsx": ["badgeTone (nsExports)"],
    "scripts/product-media.ts": ["publishMedia (exports)"],
  });
});

for (const file of [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "1",
  "žluťoučký.ts",
]) {
  test(`reported file ${file} retains its own counts and symbols across repeated rows`, () => {
    const report = {
      issues: [
        { file, exports: [{ name: "first" }] },
        { file, types: [{ name: "second" }], nsExports: [{ name: "third" }] },
      ],
    };
    expect(summarizeKnipReport(report)).toEqual({
      ".": { count: 3, files: { [file]: 3 } },
    });
    const symbols = collectIssueSymbols(report);
    expect(Object.hasOwn(symbols, file)).toBe(true);
    expect(symbols[file]).toEqual([
      "first (exports)",
      "second (types)",
      "third (nsExports)",
    ]);
  });
}
