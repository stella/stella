import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanSourceFiles } from "./source-globs";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
};

const write = (root: string, file: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), "export const value = 1;\n");
};

test("the source scan lists indexed files, never untracked ones another check is writing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-globs-"));
  try {
    git(root, "init", "-q", "-b", "main");
    for (const file of [
      "scripts/committed.ts",
      "scripts/removed.ts",
      "scripts/committed.test.ts",
      "apps/web/src/route.ts",
    ]) {
      write(root, file);
    }
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    write(root, "scripts/staged.ts");
    git(root, "add", "scripts/staged.ts");
    // A concurrent test's fixture directory: present now, gone before a
    // walker that listed it gets to read it.
    write(root, "scripts/__fixture_x1y2/transient.ts");
    write(root, "apps/web/src/untracked.ts");
    rmSync(path.join(root, "scripts/removed.ts"));

    expect(scanSourceFiles(root)).toEqual([
      "apps/web/src/route.ts",
      "scripts/committed.ts",
      "scripts/staged.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the source scan fails closed outside a git checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-globs-bare-"));
  try {
    write(root, "scripts/orphan.ts");
    expect(() => scanSourceFiles(root)).toThrow("git ls-files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
