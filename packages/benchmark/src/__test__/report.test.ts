import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { type BenchResult, renderMarkdown } from "../report";

test("development Markdown ends with exactly one newline", () => {
  const result = {
    createdAt: "2026-08-02T00:00:00.000Z",
    gitSha: "test",
    hardware: "test",
    runtime: "test",
    corpus: {
      documents: 0,
      entities: 0,
      byLanguage: {},
      byLabel: {},
    },
    matching: { primary: "test", secondary: "test" },
    libraries: [],
  } as const satisfies BenchResult;

  const markdown = renderMarkdown(result);
  expect(markdown).toMatch(/[^\n]\n$/);
  expect(markdown).not.toContain("scrubadub and redact-pii");
  expect(markdown).not.toContain("DataFog's base structured rules");
});

test("tracked development evidence comes from a clean worktree", () => {
  const resultsDirectory = join(import.meta.dir, "..", "..", "results");
  const developmentReports = readdirSync(resultsDirectory).filter((path) =>
    /^(?:development-latest|\d{4}-\d{2}-\d{2})\.(?:json|md)$/u.test(path),
  );

  expect(developmentReports.length).toBeGreaterThan(0);
  for (const path of developmentReports) {
    expect(
      readFileSync(join(resultsDirectory, path), "utf8"),
      path,
    ).not.toMatch(/(?:"gitSha":\s*"[^"]*|- Commit: .*?)-dirty/u);
  }
});
