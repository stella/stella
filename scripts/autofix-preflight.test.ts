import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decideAutofixPreflight } from "./autofix-preflight";

type DecisionFixture = {
  generatorSelected?: boolean;
  pruneRequested?: boolean;
  formatClean?: boolean;
  fixPaths?: string[];
  lintPaths?: string[];
  formatError?: boolean;
};

const decide = ({
  generatorSelected = false,
  pruneRequested = false,
  formatClean = true,
  fixPaths = ["README.md"],
  lintPaths = [],
  formatError = false,
}: DecisionFixture = {}) =>
  decideAutofixPreflight(
    {
      generatorSelected,
      pruneRequested,
      fixPaths,
      formatPaths: ["./README.md"],
      lintPaths,
    },
    {
      formatClean: () => {
        if (formatError) {
          throw new TypeError("formatter failed");
        }
        return formatClean;
      },
    },
  );

test("clean format-only files skip the full fixer", () => {
  expect(decide()).toBe("skip");
});

test("one unformatted file runs the fixers", () => {
  expect(decide({ formatClean: false })).toBe("run");
});

// The safe rules and the type-aware precheck need the installed lint
// configuration, so the fixer step answers them after the install.
test("a lint path runs the fixers", () => {
  expect(decide({ lintPaths: ["./source.ts"] })).toBe("run");
});

test("a selected generator runs the fixers", () => {
  expect(decide({ generatorSelected: true })).toBe("run");
});

test("a requested baseline prune runs the pipeline even for clean files", () => {
  expect(decide({ pruneRequested: true })).toBe("run");
});

test("a dependency manifest change runs the alignment and lockfile refresh", () => {
  expect(decide({ fixPaths: ["bun.lock"] })).toBe("run");
  expect(decide({ fixPaths: ["apps/desktop/src-tauri/Cargo.toml"] })).toBe(
    "run",
  );
  expect(decide({ fixPaths: ["package.json"] })).toBe("run");
  expect(decide({ fixPaths: ["packages/html/package.json"] })).toBe("run");
});

test("a formatter error fails closed and runs the fixers", () => {
  expect(decide({ formatError: true })).toBe("run");
});

test("the CLI emits only its GitHub output decision when a child writes stdout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-preflight-"));
  const fixPaths = path.join(root, "fix-paths");
  const formatPaths = path.join(root, "format-paths");
  const lintPaths = path.join(root, "lint-paths");
  const fakeBun = path.join(root, "bun");
  writeFileSync(fixPaths, "README.md\0");
  writeFileSync(formatPaths, "./README.md\0");
  writeFileSync(lintPaths, "");
  writeFileSync(fakeBun, "#!/bin/sh\necho child-output\nexit 0\n");
  chmodSync(fakeBun, 0o755);

  const result = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dir, "autofix-preflight.ts"),
      fixPaths,
      formatPaths,
      lintPaths,
      "false",
      "false",
    ],
    { env: { ...process.env, PATH: `${root}:${process.env["PATH"] ?? ""}` } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("run=false\n");
});
