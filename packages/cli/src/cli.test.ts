import { describe, expect, test } from "bun:test";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");

describe("stella CLI shell", () => {
  test("--version prints the package version", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "--version"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageJson.version);
  });

  test("--help exits 0", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "--help"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Stella command-line client");
  });

  test("tools list enumerates the generated command tree", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "tools", "list"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("matter list");
    expect(stdout).toContain("(list_matters)");
    expect(stdout).toContain("usage get");
    // Excluded compat shims never surface.
    expect(stdout).not.toContain("(search)");
    expect(stdout).not.toContain("(fetch)");
  });

  test("generated domain commands are wired into the root", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "matter", "--help"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("list");
    expect(result.stdout.toString()).toContain("save");
  });
});
