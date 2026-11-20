import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { REFUSING_SERVER, spawnCliSync } from "../tests/spawn-cli.js";
import {
  CACHE_SCHEMA_VERSION,
  cachePathFor,
  writeCacheFile,
} from "./registry-cache.js";

// A CLI process with no stored session, no cache, and no server in the
// environment, so exit codes reflect the argv alone.
const spawnIsolated = (args: readonly string[]) => spawnCliSync(args);

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

describe("stella CLI version admission", () => {
  test("a cached below-minimum version refuses commands but permits recovery paths", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-version-"));
    const server = REFUSING_SERVER;
    await writeCacheFile(cachePathFor(server, { XDG_CACHE_HOME: home }), {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: server,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: 86_400,
      cliMinimum: "999.0.0",
      cliLatest: "999.0.0",
    });
    const run = (args: readonly string[]) =>
      spawnCliSync(args, { home, cacheHome: home, server });

    const refused = run(["matter", "list", "--schema"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString().trim()).toEndWith(
      "run npm i -g @stll/cli@latest",
    );
    expect(refused.stderr.toString()).not.toContain("server registry differs");
    for (const args of [["--version"], ["--help"], ["update", "--help"]]) {
      expect(run(args).exitCode).toBe(0);
    }
  }, 20_000);
});

// Legacy caller listings cannot project commands in an offline invocation.
// No token is stored and the server refuses connections, so a command that
// checks compatibility fails at once instead of waiting on the network.
describe("stella CLI: offline registry projection", () => {
  const SERVER = REFUSING_SERVER;
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

  const spawnDrifted = (args: readonly string[]) =>
    spawnCliSync(args, { home, cacheHome, server: SERVER });

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
    expect(() => JSON.parse(result.stdout.toString()) as unknown).not.toThrow();
  });

  test("a legacy cache cannot authorize a write without a fresh contract", () => {
    const result = spawnDrifted(["task", "save", "--name", "x"]);
    expect(result.exitCode).toBe(2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("compatibility");
    expect(stderr).not.toContain("not available on this server");
  });
});

// The server's feature-omission evidence, once cached for the configured
// origin, projects the same commands from every listing. No token is stored
// and the server refuses connections, so nothing waits on the network.
describe("stella CLI: deployment command discovery", () => {
  const SERVER = REFUSING_SERVER;
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
    const result = spawnCliSync(args, { home, cacheHome, server: SERVER });
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
