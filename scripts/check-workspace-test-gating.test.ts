import { expect, test } from "bun:test";

import {
  bunTestCollects,
  checkWorkspaceTestGating,
  ledgerFindings,
  scriptCollectors,
  uncollectedTestFiles,
  type WorkspacePackage,
} from "./check-workspace-test-gating";

// This test is the gate: scripts/run-unlisted-script-tests.ts runs it in the
// required ci-checks-rest job.
test("every workspace test file runs in a gating job or is listed", () => {
  expect(checkWorkspaceTestGating()).toEqual([]);
});

test("bun test arguments select files the way bun does", () => {
  expect(bunTestCollects([], "src/a.test.ts")).toBe(true);
  expect(bunTestCollects(["src"], "lib/src-b.test.ts")).toBe(true);
  expect(bunTestCollects(["./src"], "lib/src-b.test.ts")).toBe(false);
  expect(bunTestCollects(["./src"], "src/a.test.ts")).toBe(true);
  expect(bunTestCollects(["src"], "scripts/a.test.ts")).toBe(false);
  expect(bunTestCollects(["src", "scripts"], "scripts/a.test.ts")).toBe(true);
  expect(bunTestCollects([], ".cache/a.test.ts")).toBe(false);
  expect(bunTestCollects([], "src/node_modules/a.test.ts")).toBe(false);
  expect(
    bunTestCollects(
      ["src", "--path-ignore-patterns", "**/*.property.test.ts"],
      "src/a.property.test.ts",
    ),
  ).toBe(false);
  expect(
    bunTestCollects(["--path-ignore-patterns=e2e/**"], "e2e/a.test.ts"),
  ).toBe(false);
  // An option value is never a path filter.
  expect(bunTestCollects(["--timeout", "src"], "lib/a.test.ts")).toBe(true);
});

const pkg = (scripts: Record<string, string>): WorkspacePackage => ({
  dir: "packages/example",
  scripts,
});

test("a test script earns credit only through plain bun test commands", () => {
  const collectors = (scripts: Record<string, string>) =>
    scriptCollectors(pkg(scripts), "test", "/repo/packages/example");

  expect(collectors({ test: "bun test src" })).toEqual([
    { type: "bun-test", args: ["src"] },
  ]);
  expect(
    collectors({ test: "bun run gen && bun run unit", unit: "bun test lib" }),
  ).toEqual([{ type: "bun-test", args: ["lib"] }]);
  expect(
    collectors({ test: "bun test --path-ignore-patterns '**/*.e2e.test.ts'" }),
  ).toEqual([
    { type: "bun-test", args: ["--path-ignore-patterns", "**/*.e2e.test.ts"] },
  ]);
  expect(collectors({ test: "bun test src || true" })).toEqual([]);
  expect(collectors({ test: "bun test $(ls src)" })).toEqual([]);
  expect(collectors({ test: "vitest run" })).toEqual([]);
  expect(collectors({ test: "bun run test" })).toEqual([]);
  expect(collectors({})).toEqual([]);
});

test("files outside every collector are reported", () => {
  const packages = [pkg({ test: "bun test src" })];
  expect(
    uncollectedTestFiles({
      files: [
        "packages/example/src/a.test.ts",
        "packages/example/scripts/b.test.ts",
        "packages/example/src/helper.ts",
        "packages/missing/src/c.test.tsx",
        "scripts/d.test.ts",
      ],
      packages,
      collectorsFor: (each) => scriptCollectors(each, "test", "/repo"),
    }),
  ).toEqual([
    "packages/example/scripts/b.test.ts",
    "packages/missing/src/c.test.tsx",
  ]);
});

test("the list names exactly the uncollected files", () => {
  const entry = { path: "packages/example/b.test.ts", reason: "Nightly only." };
  expect(ledgerFindings([entry], [entry.path])).toEqual([]);
  // A new uncollected file must be fixed or listed.
  expect(ledgerFindings([], [entry.path])).toHaveLength(1);
  // A listed file that is now collected or gone must leave the list.
  expect(ledgerFindings([entry], [])).toHaveLength(1);
  expect(
    ledgerFindings([{ ...entry, reason: " " }], [entry.path]),
  ).toHaveLength(1);
  expect(ledgerFindings([entry, entry], [entry.path])).toHaveLength(1);
});
