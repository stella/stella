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

  test("tools list stub reports it is not yet implemented", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "tools", "list"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(
      "stella tools list: not yet implemented",
    );
  });
});
