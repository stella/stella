import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { changedFilesSince } from "./expiry-check-scope-git";

const git = (cwd: string, args: readonly string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new TypeError(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

test("a moved owner file stays in scope under its old and new path", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "expiry-scope-"));
  try {
    git(cwd, ["init", "--quiet"]);
    git(cwd, ["config", "user.email", "fixture@example.invalid"]);
    git(cwd, ["config", "user.name", "Fixture"]);
    git(cwd, ["config", "diff.renames", "true"]);
    mkdirSync(path.join(cwd, "apps/old"), { recursive: true });
    writeFileSync(
      path.join(cwd, "apps/old/package.json"),
      `${JSON.stringify({ name: "fixture", dependencies: { left: "1.0.0" } }, null, 2)}\n`,
    );
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "--quiet", "-m", "base"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(cwd, "apps/new"), { recursive: true });
    git(cwd, ["mv", "apps/old/package.json", "apps/new/package.json"]);
    git(cwd, ["commit", "--quiet", "-m", "move"]);

    expect([...changedFilesSince(base, cwd)].toSorted()).toEqual([
      "apps/new/package.json",
      "apps/old/package.json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
