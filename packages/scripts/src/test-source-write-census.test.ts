import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSourceWriteCensus } from "./test-source-write-census";

test("a census deadline reports its budget instead of an interrupted ledger diagnostic", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-census-deadline-"));
  const entrypoint = path.join(root, "census.ts");
  const ready = path.join(root, "ready");
  try {
    writeFileSync(
      entrypoint,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(ready)}, "started");`,
        'process.stderr.write("Source-write ledger merge base unavailable: ");',
        "Bun.sleepSync(10_000);",
      ].join("\n"),
    );
    const issues = runSourceWriteCensus({ entrypoint, budgetMs: 1000 });
    expect(readFileSync(ready, "utf-8")).toBe("started");
    expect(issues).toEqual(["Source-write census exceeded budget 1s"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed census preserves ledger failures and cannot become a pass", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-census-failure-"));
  const entrypoint = path.join(root, "census.ts");
  const diagnostic =
    "Source-write exceptions may only shrink: unexpected write";
  try {
    writeFileSync(
      entrypoint,
      `process.stderr.write(${JSON.stringify(diagnostic)});\nprocess.exitCode = 1;`,
    );
    expect(runSourceWriteCensus({ entrypoint, budgetMs: 1000 })).toEqual([
      `Source-write census failed: ${diagnostic}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
