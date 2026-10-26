import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = "scripts/require-hook-deps.sh";

type Result = { exitCode: number; stderr: string; bunCalled: boolean };

// A checkout holding only the script, with a `bun` on PATH that records any
// call, so the test sees an install attempt instead of running one.
const withCheckout = (
  check: (checkout: string, run: (...args: string[]) => Result) => void,
) => {
  const checkout = mkdtempSync(path.join(tmpdir(), "require-hook-deps-"));
  try {
    mkdirSync(path.join(checkout, "scripts"));
    copyFileSync(path.join(ROOT, SCRIPT), path.join(checkout, SCRIPT));
    const bin = path.join(checkout, "fake-bin");
    mkdirSync(bin);
    const calls = path.join(checkout, "bun-calls");
    writeFileSync(
      path.join(bin, "bun"),
      `#!/bin/sh\necho "$@" >> "${calls}"\n`,
    );
    chmodSync(path.join(bin, "bun"), 0o755);
    check(checkout, (...args) => {
      const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
        cwd: checkout,
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        bunCalled: existsSync(calls),
      };
    });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
};

describe("the deps hook", () => {
  test("refuses with the exact install command and installs nothing", () => {
    withCheckout((checkout, run) => {
      mkdirSync(path.join(checkout, "apps/web"), { recursive: true });
      const result = run("packages/scripts", "apps/web");
      expect(result.exitCode).toBe(1);
      expect(result.bunCalled).toBe(false);
      expect(result.stderr).toContain(
        "bun install --frozen-lockfile --ignore-scripts --filter ./ --filter ./packages/scripts --filter ./apps/web\n",
      );
    });
  });

  test("passes silently once the checkout has what the hooks import", () => {
    withCheckout((checkout, run) => {
      mkdirSync(path.join(checkout, "node_modules"));
      mkdirSync(path.join(checkout, "apps/web/node_modules"), {
        recursive: true,
      });
      expect(run("apps/web")).toEqual({
        exitCode: 0,
        stderr: "",
        bunCalled: false,
      });
    });
  });

  test("no git hook runs an install", () => {
    const hooks = readFileSync(path.join(ROOT, "lefthook.yml"), "utf-8");
    const script = readFileSync(path.join(ROOT, SCRIPT), "utf-8");
    for (const text of [hooks, script]) {
      const commands = text
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line) && !/^\s*echo\b/u.test(line));
      expect(
        commands.filter((line) => /\bbun\s+(?:install|i|add)\b/u.test(line)),
      ).toEqual([]);
    }
  });
});
