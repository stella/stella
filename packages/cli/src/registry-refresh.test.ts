import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generatedRouteMap } from "./generated/route-map.js";
import { McpClientError } from "./mcp-client.js";
import {
  cachePathFor,
  readCacheFile,
  writeCacheFile,
  type RegistryCacheFile,
} from "./registry-cache.js";
import {
  refreshRegistryCache,
  resolveCommandTree,
} from "./registry-refresh.js";
import type { RegistryToolListing, RouteNode } from "./route-types.js";

const ORIGIN = "https://api.example.com";
const tempDirs: string[] = [];

const makeCacheEnv = async (): Promise<{ XDG_CACHE_HOME: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "stella-refresh-"));
  tempDirs.push(dir);
  return { XDG_CACHE_HOME: dir };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

const listing = (name: string): RegistryToolListing => ({
  name,
  description: "d",
  inputSchema: { type: "object", properties: {} },
});

/** Count leaves of one kind (curated `leaf` vs generated `capability-leaf`). */
const countLeavesOfKind = (
  node: RouteNode,
  kind: "leaf" | "capability-leaf",
): number => {
  if (node.kind === kind) {
    return 1;
  }
  if (node.kind !== "route") {
    return 0;
  }
  let count = 0;
  for (const child of Object.values(node.children)) {
    count += countLeavesOfKind(child, kind);
  }
  return count;
};

const toolsBody = (names: readonly string[]): string =>
  JSON.stringify({
    result: {
      tools: names.map((name) => ({
        name,
        description: "d",
        inputSchema: { type: "object", properties: {} },
      })),
    },
  });

const okFetch =
  (raw: string, headers: { cliLatest?: string; cliMinimum?: string } = {}) =>
  async () =>
    await Promise.resolve(Result.ok({ rawBody: raw, ...headers }));
const errFetch = () => async () =>
  await Promise.resolve(
    Result.err(new McpClientError({ kind: "transport", message: "offline" })),
  );

const writeCache = async (
  env: { XDG_CACHE_HOME: string },
  over: Partial<RegistryCacheFile>,
): Promise<string> => {
  const filePath = cachePathFor(ORIGIN, env);
  const file: RegistryCacheFile = {
    version: 2,
    serverOrigin: ORIGIN,
    fetchedAt: new Date().toISOString(),
    ttlSeconds: 86_400,
    toolsListHash: "h",
    listings: [listing("list_matters")],
    delta: { added: [], removed: [], changed: [] },
    ...over,
  };
  await writeCacheFile(filePath, file);
  return filePath;
};

describe("resolveCommandTree (S5.3)", () => {
  test("no cache -> baked-in tree, no notice", async () => {
    const env = await makeCacheEnv();
    const { tree, notice } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(tree).toBe(generatedRouteMap);
    expect(notice).toBeUndefined();
  });

  test("empty delta -> baked-in tree", async () => {
    const env = await makeCacheEnv();
    await writeCache(env, { delta: { added: [], removed: [], changed: [] } });
    const { tree, notice } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(tree).toBe(generatedRouteMap);
    expect(notice).toBeUndefined();
  });

  test("non-empty delta -> cached-listings tree + one-line notice", async () => {
    const env = await makeCacheEnv();
    await writeCache(env, {
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    const { tree, notice } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(tree).not.toBe(generatedRouteMap);
    expect(notice).toBe(
      "server registry differs (+1 −0 ~0); see 'stella tools list'\n",
    );
  });

  test("a rebuilt (diverged) tree still carries the capability leaves", async () => {
    const env = await makeCacheEnv();
    await writeCache(env, {
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    const { tree } = await resolveCommandTree({ serverOrigin: ORIGIN, env });
    expect(tree).not.toBe(generatedRouteMap);
    // The fetched curated tool is present...
    expect(countLeavesOfKind(tree, "leaf")).toBeGreaterThan(0);
    // ...and the baked capability merge ran: the rebuilt tree carries the same
    // capability leaves as the baked-in tree (they must never vanish on a
    // registry divergence).
    const capabilityLeaves = countLeavesOfKind(tree, "capability-leaf");
    expect(capabilityLeaves).toBe(
      countLeavesOfKind(generatedRouteMap, "capability-leaf"),
    );
    expect(capabilityLeaves).toBeGreaterThan(200);
  });

  test("provenance pin: a cache for a different origin is ignored (rule 5)", async () => {
    const env = await makeCacheEnv();
    // Write a file whose stored origin differs from the one we resolve for.
    await writeCache(env, {
      serverOrigin: "https://other.example",
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    // The cache path is keyed by ORIGIN's hash, so plant the mismatched file there.
    const { tree, notice } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(tree).toBe(generatedRouteMap);
    expect(notice).toBeUndefined();
  });
});

describe("refreshRegistryCache (S5.3/S5.5)", () => {
  test("skips (no network) when no cache exists and not forced", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      fetchRaw: () => {
        throw new Error("must not fetch");
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no-cache" });
  });

  test("skips a fresh existing cache when not forced", async () => {
    const env = await makeCacheEnv();
    await writeCache(env, { fetchedAt: new Date().toISOString() });
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      fetchRaw: () => {
        throw new Error("must not fetch");
      },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "fresh" });
  });

  test("force fetches, validates, diffs, and writes the cache", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchRaw: okFetch(toolsBody(["list_matters", "list_widgets"])),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome).toEqual({ status: "refreshed", deltaEmpty: false });
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    expect(written?.serverOrigin).toBe(ORIGIN);
    expect(written?.delta.added).toEqual(["list_widgets"]);
    expect(written?.toolsListHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("empty delta still refreshes (fetchedAt bumped) with deltaEmpty=true", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchRaw: okFetch(toolsBody(["list_matters"])),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome).toEqual({ status: "refreshed", deltaEmpty: true });
  });

  test("fail closed: an invalid body is rejected and NOT written (rule 6)", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchRaw: okFetch(toolsBody(["Bad Name"])), // invalid tool name
      bakedListings: [listing("list_matters")],
    });
    expect(outcome.status).toBe("failed");
    expect(await readCacheFile(cachePathFor(ORIGIN, env))).toBeUndefined();
  });

  test("fail closed: a transport error is rejected and NOT written (rule 6)", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchRaw: errFetch(),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome.status).toBe("failed");
    expect(await readCacheFile(cachePathFor(ORIGIN, env))).toBeUndefined();
  });

  test("unknown fetched tools flow through the SAME generateRouteMap heuristics", async () => {
    const env = await makeCacheEnv();
    // A validated but unannotated tool: the cached-listings tree must place it
    // via the S1 verb/domain heuristic (list_widgets -> `widgets list`).
    await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchRaw: okFetch(toolsBody(["list_matters", "list_widgets"])),
      bakedListings: [listing("list_matters")],
    });
    const { tree } = await resolveCommandTree({ serverOrigin: ORIGIN, env });
    expect(tree.kind).toBe("route");
    if (tree.kind === "route") {
      const widgets = tree.children["widgets"];
      expect(widgets?.kind).toBe("route");
    }
  });
});

describe("CLI update nudge (spec 051 addendum)", () => {
  const refreshWith = async (over: {
    cliLatest?: string;
    cliMinimum?: string;
    currentVersion: string;
    lastNudged?: string;
  }) => {
    const env = await makeCacheEnv();
    if (over.lastNudged !== undefined) {
      await writeCache(env, {
        fetchedAt: new Date(0).toISOString(), // stale, so a non-forced path would refresh
        lastNudgedVersion: over.lastNudged,
      });
    }
    return {
      env,
      outcome: await refreshRegistryCache({
        serverOrigin: ORIGIN,
        token: "t",
        env,
        force: true,
        currentVersion: over.currentVersion,
        fetchRaw: okFetch(toolsBody(["list_matters"]), {
          ...(over.cliLatest === undefined
            ? {}
            : { cliLatest: over.cliLatest }),
          ...(over.cliMinimum === undefined
            ? {}
            : { cliMinimum: over.cliMinimum }),
        }),
        bakedListings: [listing("list_matters")],
      }),
    };
  };

  test("a newer server-advertised version prints exactly one nudge line", async () => {
    const { outcome, env } = await refreshWith({
      currentVersion: "0.1.0",
      cliLatest: "0.2.0",
    });
    expect(outcome).toEqual({
      status: "refreshed",
      deltaEmpty: true,
      nudge: "stella 0.1.0 -> 0.2.0 available; npm i -g @stll/cli",
    });
    // The anti-nag key is persisted for the next refresh.
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    expect(written?.lastNudgedVersion).toBe("0.2.0");
  });

  test("the same or an older advertised version is silent", async () => {
    const same = await refreshWith({
      currentVersion: "0.2.0",
      cliLatest: "0.2.0",
    });
    expect(same.outcome).toEqual({ status: "refreshed", deltaEmpty: true });
    const older = await refreshWith({
      currentVersion: "0.3.0",
      cliLatest: "0.2.0",
    });
    expect(older.outcome).toEqual({ status: "refreshed", deltaEmpty: true });
  });

  test("a malformed advertised version is silent (fail-silent parse)", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      cliLatest: "not-a-version",
    });
    expect(outcome).toEqual({ status: "refreshed", deltaEmpty: true });
  });

  test("a minimum above the current version warns it is unsupported", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      cliLatest: "0.3.0",
      cliMinimum: "0.2.0",
    });
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") {
      expect(outcome.nudge).toBe(
        "stella 0.1.0 is no longer supported (server requires >= 0.2.0); upgrade with: npm i -g @stll/cli",
      );
    }
  });

  test("anti-nag: the version already nudged is not nudged again within TTL", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      cliLatest: "0.2.0",
      lastNudged: "0.2.0",
    });
    expect(outcome).toEqual({ status: "refreshed", deltaEmpty: true });
  });
});
