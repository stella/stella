import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import {
  CACHE_SCHEMA_VERSION,
  cachePathFor,
  writeCacheFile,
} from "./registry-cache.js";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");

// A CLI process with no stored session, no cache, and no server in the
// environment, so exit codes reflect the argv alone.
const spawnIsolated = (args: readonly string[]) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-shell-"));
  const {
    STELLA_SERVER_URL: _server,
    STELLA_API_KEY: _key,
    ...env
  } = process.env;
  return Bun.spawnSync({
    cmd: ["bun", CLI_ENTRYPOINT, ...args],
    env: {
      ...env,
      HOME: home,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
};

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

  test("--help documents the exit-code contract", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, "--help"],
      stderr: "pipe",
      stdout: "pipe",
    });

    const stdout = result.stdout.toString();
    expect(stdout).toContain("Exit codes:");
    expect(stdout).toContain(" 2  usage or input validation error");
    expect(stdout).toContain(" 5  feature disabled for this organization");
    expect(stdout).toContain("10  conflict with current state");
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

  // The documented contract (root --help) is the whole exit-code surface;
  // stricli's own negative codes (folded to 251/252 by the OS) and its default 1
  // for a returned Error must never reach the caller.
  test("an unknown command exits 2, not stricli's 251", () => {
    const result = spawnIsolated(["matters", "list"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("did you mean `matter`");
  });

  test("an unknown flag exits 2, not stricli's 252", () => {
    const result = spawnIsolated(["matter", "list", "--limt", "2"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--limit");
  });

  test("a command with no server configured exits 3", () => {
    const result = spawnIsolated(["auth", "whoami"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("No server configured");
  });
});

// A cached delta for the configured origin, so startup resolves a diverged
// tree. No token is stored, so nothing reaches the network.
describe("stella CLI: registry drift reporting", () => {
  const SERVER = "https://drift.example";
  const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-drift-"));
  const cacheHome = path.join(home, ".cache");
  const REMOVED = ["save_task", "delete_task"];

  beforeAll(async () => {
    await writeCacheFile(cachePathFor(SERVER, { XDG_CACHE_HOME: cacheHome }), {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: SERVER,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 86_400,
      toolsListHash: "h",
      listings: [
        {
          name: "list_matters",
          description: "d",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      delta: {
        added: [],
        removed: REMOVED,
        changed: ["lookup_business_registry"],
      },
    });
  });

  const spawnDrifted = (args: readonly string[]) => {
    const {
      STELLA_SERVER_URL: _server,
      STELLA_API_KEY: _key,
      ...env
    } = process.env;
    return Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, ...args],
      env: {
        ...env,
        HOME: home,
        STELLA_SERVER_URL: SERVER,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
  };

  const driftLines = (stderr: string): string[] =>
    stderr.split("\n").filter((line) => line.includes("server registry"));

  test("a domain command gets one counted line on stderr, not the tool lists", () => {
    const result = spawnDrifted(["matter", "list", "--schema"]);
    expect(driftLines(result.stderr.toString())).toEqual([
      "server registry differs from this CLI build: 2 removed, 1 changed; re-run with --verbose to list the tools",
    ]);
    for (const tool of REMOVED) {
      expect(result.stderr.toString()).not.toContain(tool);
    }
  });

  test("--help, auth and compatibility say nothing about it", () => {
    for (const args of [
      ["--help"],
      ["matter", "list", "--help"],
      ["auth", "whoami"],
      ["compatibility", "--help"],
    ]) {
      const result = spawnDrifted(args);
      expect(driftLines(result.stderr.toString())).toEqual([]);
    }
  });

  test("--verbose lists every diverged tool", () => {
    const stderr = spawnDrifted([
      "matter",
      "list",
      "--schema",
      "--verbose",
    ]).stderr.toString();
    expect(stderr).toContain("2 removed, 1 changed\n");
    expect(stderr).toContain(`  removed: ${REMOVED.join(", ")}`);
    expect(stderr).toContain("  changed: lookup_business_registry");
  });

  test("stdout stays machine-readable under --json", () => {
    const result = spawnDrifted(["matter", "list", "--schema", "--json"]);
    expect(result.stdout.toString()).not.toContain("server registry");
    expect(() => JSON.parse(result.stdout.toString())).not.toThrow();
  });

  test("a command whose tool the server dropped fails with a clear error", () => {
    // `save_task` is removed above; its command is still in this CLI build.
    const result = spawnDrifted(["task", "save", "--title", "x"]);
    expect(result.exitCode).toBe(4);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "stella task save is not available on this server",
    );
    expect(stderr).toContain("save_task");
    expect(stderr).toContain("stella tools list");
  });
});

// The server's feature-omission evidence, once cached for the configured
// origin, marks the same commands in every listing. No token is stored, so
// nothing reaches the network.
describe("stella CLI: server-attested disabled commands", () => {
  const SERVER = "https://stella.example";
  const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-disabled-"));
  const cacheHome = path.join(home, ".cache");
  beforeAll(async () => {
    await writeCacheFile(cachePathFor(SERVER, { XDG_CACHE_HOME: cacheHome }), {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: SERVER,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 86_400,
      toolsListHash: "h",
      listings: [],
      delta: { added: [], removed: [], changed: [] },
      featureOmittedTools: ["get_usage"],
      featureOmittedCapabilities: ["usage.entitlement.get"],
    });
  });

  const spawnAgainstServer = (args: readonly string[]) => {
    const {
      STELLA_SERVER_URL: _server,
      STELLA_API_KEY: _key,
      ...env
    } = process.env;
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_ENTRYPOINT, ...args],
      env: {
        ...env,
        HOME: home,
        STELLA_SERVER_URL: SERVER,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };

  test("root --help marks the gated-off group and names it under capability", () => {
    const stdout = spawnAgainstServer(["--help"]);
    expect(stdout).toMatch(
      /^ {2}usage +usage commands: get \[disabled on this server\]$/mu,
    );
    expect(stdout).toMatch(
      /^ {2}capability +capability commands: .*\[disabled on this server: usage\]$/mu,
    );
  });

  test("capability --help marks the gated-off capability", () => {
    const stdout = spawnAgainstServer(["capability", "usage", "--help"]);
    expect(stdout).toMatch(
      /^ {2}entitlement-get .*\[disabled on this server\]$/mu,
    );
  });

  test("tools list marks the gated-off tool and capability, and nothing else", () => {
    const marked = spawnAgainstServer(["tools", "list"])
      .split("\n")
      .filter((line) => line.endsWith("[disabled on this server]"));
    expect(marked).toEqual([
      "capability usage entitlement-get\t(invoke_capability: usage.entitlement.get) [disabled on this server]",
      "usage get\t(get_usage) [disabled on this server]",
    ]);
  });
});
