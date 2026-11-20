import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bunTestCollects,
  checkUngatedLedgerMembership,
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
  const entry = { id: "packages/example/b.test.ts", reason: "Nightly only." };
  expect(ledgerFindings([entry], [entry.id])).toEqual([]);
  // A new uncollected file must be fixed or listed.
  expect(ledgerFindings([], [entry.id])).toHaveLength(1);
  // A listed file that is now collected or gone must leave the list.
  expect(ledgerFindings([entry], [])).toHaveLength(1);
  expect(ledgerFindings([{ ...entry, reason: " " }], [entry.id])).toHaveLength(
    1,
  );
  expect(ledgerFindings([entry, entry], [entry.id])).toHaveLength(1);
});

const LEDGER = "scripts/ungated-workspace-tests-ledger.json";

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
};

const writeLedger = (root: string, ids: readonly string[]) => {
  writeFileSync(
    path.join(root, LEDGER),
    JSON.stringify(ids.map((id) => ({ id, reason: "Nightly only." }))),
  );
};

/** A repository whose base commit lists `packages/example/old.test.ts`. */
const withBaseRepo = (run: (root: string) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), "ungated-workspace-tests-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "packages/example"), { recursive: true });
    writeFileSync(path.join(root, "packages/example/old.test.ts"), "old\n");
    writeLedger(root, ["packages/example/old.test.ts"]);
    git(root, ["init", "-q", "--initial-branch=base"]);
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const membership = (root: string) => {
  const errors: string[] = [];
  const status = checkUngatedLedgerMembership({
    args: ["--base", "HEAD"],
    repoRoot: root,
    log: () => {},
    error: (message) => {
      errors.push(message);
    },
  });
  return { status, errors: errors.join("\n") };
};

test("the list refuses an entry its base does not have", () => {
  withBaseRepo((root) => {
    writeLedger(root, [
      "packages/example/new.test.ts",
      "packages/example/old.test.ts",
    ]);
    const { status, errors } = membership(root);
    expect(status).toBe(1);
    expect(errors).toContain("packages/example/new.test.ts");
    expect(errors).not.toContain("packages/example/old.test.ts");
  });
});

test("the list refuses swapping one entry for another", () => {
  withBaseRepo((root) => {
    writeLedger(root, ["packages/example/new.test.ts"]);
    expect(membership(root).status).toBe(1);
  });
});

test("the list may shrink, and a renamed file keeps its entry", () => {
  withBaseRepo((root) => {
    writeLedger(root, []);
    expect(membership(root).status).toBe(0);
  });
  withBaseRepo((root) => {
    git(root, [
      "mv",
      "packages/example/old.test.ts",
      "packages/example/renamed.test.ts",
    ]);
    writeLedger(root, ["packages/example/renamed.test.ts"]);
    expect(membership(root).status).toBe(0);
  });
});
