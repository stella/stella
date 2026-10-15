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
    const result = spawnIsolated(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageJson.version);
  });

  test("--help exits 0", () => {
    const result = spawnIsolated(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Stella command-line client");
  });

  test("--help documents the exit-code contract", () => {
    const result = spawnIsolated(["--help"]);

    const stdout = result.stdout.toString();
    expect(stdout).toContain("Exit codes:");
    expect(stdout).toContain(" 2  usage or input validation error");
    expect(stdout).toContain(" 5  feature disabled for this organization");
    expect(stdout).toContain("10  conflict with current state");
  });

  test("tools list enumerates the generated command tree", () => {
    const result = spawnIsolated(["tools", "list"]);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("matter list");
    expect(stdout).toContain("(list_matters)");
    expect(stdout).not.toContain("usage get");
    // Excluded compat shims never surface.
    expect(stdout).not.toContain("(search)");
    expect(stdout).not.toContain("(fetch)");
  });

  test("generated domain commands are wired into the root", () => {
    const result = spawnIsolated(["matter", "--help"]);

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

// Legacy caller listings cannot project commands in an offline invocation.
// No token is stored, so nothing reaches the network.
describe("stella CLI: offline registry projection", () => {
  const SERVER = "https://drift.example";
  const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-drift-"));
  const cacheHome = path.join(home, ".cache");
  const REMOVED = ["save_task", "delete_task"];

  beforeAll(async () => {
    const filePath = cachePathFor(SERVER, { XDG_CACHE_HOME: cacheHome });
    await writeCacheFile(filePath, {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: SERVER,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 86_400,
    });
    await Bun.write(
      filePath,
      JSON.stringify({
        version: 4,
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
      }),
    );
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

  test("an offline domain command ignores cached caller drift", () => {
    const result = spawnDrifted(["matter", "list", "--schema"]);
    expect(result.exitCode).toBe(0);
    expect(driftLines(result.stderr.toString())).toEqual([]);
    for (const tool of REMOVED) {
      expect(result.stderr.toString()).not.toContain(tool);
    }
  });

  for (const args of [
    ["--help"],
    ["matter", "list", "--help"],
    ["auth", "whoami"],
    ["compatibility", "--help"],
  ]) {
    test(`${args.join(" ")} says nothing about it`, () => {
      const result = spawnDrifted(args);
      expect(driftLines(result.stderr.toString())).toEqual([]);
    });
  }

  test("--verbose does not expose legacy caller drift", () => {
    const stderr = spawnDrifted([
      "matter",
      "list",
      "--schema",
      "--verbose",
    ]).stderr.toString();
    expect(driftLines(stderr)).toEqual([]);
    expect(stderr).not.toContain(REMOVED.join(", "));
    expect(stderr).not.toContain("lookup_business_registry");
  });

  test("stdout stays machine-readable under --json", () => {
    const result = spawnDrifted(["matter", "list", "--schema", "--json"]);
    expect(result.stdout.toString()).not.toContain("server registry");
    expect(() => JSON.parse(result.stdout.toString())).not.toThrow();
  });

  test("legacy caller omissions do not disable baked commands offline", () => {
    const result = spawnDrifted(["task", "save", "--name", "x"]);
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("Not signed in");
    expect(stderr).not.toContain("not available on this server");
  });
});

// The server's feature-omission evidence, once cached for the configured
// origin, projects the same commands from every listing. No token is stored, so
// nothing reaches the network.
describe("stella CLI: deployment command discovery", () => {
  const SERVER = "https://stella.example";
  const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-disabled-"));
  const cacheHome = path.join(home, ".cache");
  beforeAll(async () => {
    await writeCacheFile(cachePathFor(SERVER, { XDG_CACHE_HOME: cacheHome }), {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: SERVER,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 86_400,
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

  test("root help omits empty deployment-disabled groups", () => {
    const stdout = spawnAgainstServer(["--help"]);
    expect(stdout).not.toMatch(/^ {2}usage +/mu);
    expect(stdout).not.toContain("disabled on this server");
    expect(stdout).toMatch(/^ {2}matter +/mu);
  });

  test("capability help omits the disabled domain", () => {
    const stdout = spawnAgainstServer(["capability", "--help"]);
    expect(stdout).not.toMatch(/^ {2}usage +/mu);
    expect(stdout).not.toContain("disabled on this server");
  });

  test("tools list omits disabled identities and keeps eligible commands", () => {
    const stdout = spawnAgainstServer(["tools", "list"]);
    expect(stdout).not.toContain("usage.entitlement.get");
    expect(stdout).not.toContain("(get_usage)");
    expect(stdout).not.toContain("disabled on this server");
    expect(stdout).toContain("(list_matters)");
  });
});
