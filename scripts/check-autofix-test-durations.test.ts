import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateAutofixTestDurations } from "./check-autofix-test-durations";

const existing =
  '"src/existing.test.ts": { "seconds": 1.2000000, "source": "measured" }';
const addition = '"src/new.test.ts": { "seconds": 1.2, "source": "estimated" }';
const original = `{ ${existing} }\n`;

const validate = (
  updated: string,
  addedFiles: readonly string[] = ["apps/api/src/new.test.ts"],
) => validateAutofixTestDurations({ original, updated, addedFiles });

describe("autofix API duration append-only boundary", () => {
  test("allows exactly the new PR test entries while preserving existing value bytes", () => {
    validate(original);
    validate(`{ ${existing}, ${addition} }\n`);
    validate(`{ ${existing}, ${addition}, "src/view.test.tsx": {} }\n`, [
      "apps/api/src/new.test.ts",
      "apps/api/src/view.test.tsx",
    ]);
  });

  test.each([
    ["precision", existing.replace("1.2000000", "1.2")],
    ["seconds", existing.replace("1.2000000", "2.2000000")],
    ["source", existing.replace("measured", "estimated")],
    ["format", existing.replace('{ "seconds"', '{\n  "seconds"')],
  ])("rejects edits to existing %s", (_kind, changed) => {
    expect(() => validate(`{ ${changed}, ${addition} }`)).toThrow(
      "Autofix changed existing API duration: src/existing.test.ts",
    );
  });

  test("rejects deleting an existing entry", () => {
    expect(() => validate(`{ ${addition} }`)).toThrow(
      "Autofix removed API duration: src/existing.test.ts",
    );
  });

  test.each([
    { addedFiles: [] },
    { addedFiles: ["apps/api/src/existing.test.ts"] },
    { addedFiles: ["apps/web/src/new.test.ts"] },
    { addedFiles: ["apps/api/src/new.ts"] },
  ])(
    "rejects weights for unrelated or non-added files: %j",
    ({ addedFiles }) => {
      expect(() =>
        validate(`{ ${existing}, ${addition} }`, addedFiles),
      ).toThrow(
        "Autofix added duration for a file not added by this PR: src/new.test.ts",
      );
    },
  );

  test("rejects duplicate keys that hide edits behind an unchanged first value", () => {
    expect(() =>
      validate(`{ ${existing}, ${existing.replace("measured", "estimated")} }`),
    ).toThrow("Duplicate API duration key: src/existing.test.ts");
  });
});

const git = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

test("CLI compares the original PR head against worktree using added files from the PR diff", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-duration-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "apps/api/scripts"), { recursive: true });
    mkdirSync(path.join(root, "apps/api/src"), { recursive: true });
    for (const file of [
      "check-autofix-test-durations.ts",
      "json-text-edit.ts",
    ]) {
      copyFileSync(
        path.join(import.meta.dirname, file),
        path.join(root, "scripts", file),
      );
    }
    const weights = path.join(root, "apps/api/scripts/test-durations.json");
    writeFileSync(weights, original);
    writeFileSync(
      path.join(root, "apps/api/src/existing.test.ts"),
      "existing\n",
    );
    writeFileSync(path.join(root, "apps/api/src/old.test.ts"), "old\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["add", "."]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "apps/api/src/new.test.ts"), "new\n");
    writeFileSync(
      path.join(root, "apps/api/src/existing.test.ts"),
      "changed\n",
    );
    writeFileSync(path.join(root, "apps/api/src/old.test.ts"), "modified\n");
    git(root, ["add", "."]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add test"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const check = () =>
      Bun.spawnSync(
        [
          process.execPath,
          "scripts/check-autofix-test-durations.ts",
          "--base",
          base,
          "--head",
          head,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );

    writeFileSync(weights, `{ ${existing}, ${addition} }\n`);
    const accepted = check();
    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);

    writeFileSync(
      weights,
      `{ ${existing.replace("1.2000000", "1.2")}, ${addition} }\n`,
    );
    const rejected = check();
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain(
      "Autofix changed existing API duration",
    );

    // A modified test file is not an addition, even when its weight was absent at HEAD.
    writeFileSync(weights, `{ ${existing}, "src/old.test.ts": {} }\n`);
    const unrelated = check();
    expect(unrelated.exitCode).not.toBe(0);
    expect(unrelated.stderr.toString()).toContain(
      "not added by this PR: src/old.test.ts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
