import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { missingDependencyMessage } from "./missing-dependency.js";

const moduleNotFound = (message: string) =>
  Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });

describe("missingDependencyMessage", () => {
  test.each([
    ["Bun", "Cannot find package '@stricli/core' imported from /x/cli-main.ts"],
    ["Node", "Cannot find package 'better-result' imported from /x/cli.js"],
  ])("names the package %s could not resolve", (_runtime, message) => {
    expect(missingDependencyMessage(moduleNotFound(message))).toMatch(
      /^Dependencies are missing \(cannot load [@\w/-]+\): run `bun install` first\.$/u,
    );
  });

  test.each([
    [
      "a missing relative module",
      moduleNotFound(
        "Cannot find module './generated/route-map.js' imported from /x/cli-main.ts",
      ),
    ],
    [
      "a package error without the code",
      new Error("Cannot find package '@stricli/core'"),
    ],
    ["an unrelated error", new TypeError("boom")],
    ["a thrown string", "Cannot find package '@stricli/core'"],
  ])("leaves %s alone", (_label, error) => {
    expect(missingDependencyMessage(error)).toBeNull();
  });
});

describe("the entry point without installed packages", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  /** The real entry point beside a stand-in shell, outside any install. */
  const runEntry = async (shell: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-cli-entry-"));
    dirs.push(dir);
    for (const file of ["cli.ts", "missing-dependency.ts"]) {
      await copyFile(
        path.join(import.meta.dirname, file),
        path.join(dir, file),
      );
    }
    await writeFile(path.join(dir, "cli-main.ts"), shell);
    const proc = Bun.spawn({
      // No auto-install: a checkout has a node_modules, so Bun never
      // fetches a missing package there; outside one it would.
      cmd: ["bun", "--no-install", path.join(dir, "cli.ts"), "--help"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stderr, exitCode };
  };

  test("a missing package is one line naming the install step", async () => {
    const result = await runEntry('import "@stricli/core";\n');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "stella: Dependencies are missing (cannot load @stricli/core): run `bun install` first.\n",
    );
  });

  test("any other load failure is rethrown as it was", async () => {
    const result = await runEntry('throw new Error("shell failed to load");\n');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("shell failed to load");
    expect(result.stderr).not.toContain("Dependencies are missing");
  });
});
