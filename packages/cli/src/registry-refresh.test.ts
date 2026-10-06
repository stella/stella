import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { projectFeatureCommands } from "./feature-command-projection.js";
import { generatedRouteMap } from "./generated/route-map.js";
import { generatedToolAnnotations } from "./generated/tool-annotations.js";
import { McpClientError } from "./mcp-client.js";
import {
  CACHE_SCHEMA_VERSION,
  cachePathFor,
  readCacheFile,
  writeCacheFile,
  type RegistryCacheFile,
} from "./registry-cache.js";
import {
  type CurrentRegistry,
  refreshRegistryCache,
  resolveCommandTree,
} from "./registry-refresh.js";
import { validateFetchedToolsList } from "./registry-trust.js";
import type { RegistryToolListing, RouteNode } from "./route-types.js";

const capabilityCatalog = loadBakedCapabilityCatalog();
if (capabilityCatalog === null) {
  panic("Invalid committed refresh-test capability catalog");
}
const gatedCapabilityIds = new Set(
  capabilityCatalog
    .filter((entry) => entry.featureAccess === "required")
    .map(({ id }) => id),
);
const admittedFeatures = {
  capabilities: capabilityCatalog
    .filter((entry) => entry.featureId !== undefined)
    .map(({ id }) => id),
  tools: Object.entries(generatedToolAnnotations).flatMap(
    ([name, annotation]) => (annotation.featureId === undefined ? [] : [name]),
  ),
};

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

const capabilityLeafIds = (node: RouteNode): string[] => {
  switch (node.kind) {
    case "capability-leaf":
      return [node.spec.capabilityId];
    case "leaf":
      return [];
    case "route":
      return Object.values(node.children).flatMap(capabilityLeafIds);
    default: {
      node satisfies never;
      return panic("Unexpected command node");
    }
  }
};

const curatedLeavesForTool = (
  node: RouteNode,
  toolName: string,
): Extract<RouteNode, { kind: "leaf" }>["spec"][] => {
  if (node.kind === "leaf") {
    return node.spec.toolName === toolName ? [node.spec] : [];
  }
  if (node.kind !== "route") {
    return [];
  }
  return Object.values(node.children).flatMap((child) =>
    curatedLeavesForTool(child, toolName),
  );
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
  (
    raw: string,
    headers: {
      cliMinimum?: string;
      grantedScopes?: readonly string[];
      scopeOmittedTools?: readonly string[];
      featureOmittedTools?: readonly string[];
      featureOmittedCapabilities?: readonly string[];
    } = {},
  ) =>
  async () =>
    await Promise.resolve(Result.ok({ rawBody: raw, ...headers }));
const errFetch = () => async () =>
  await Promise.resolve(
    Result.err(new McpClientError({ kind: "transport", message: "offline" })),
  );

const writeCache = async (
  env: { XDG_CACHE_HOME: string },
  over: Partial<RegistryCacheFile & CurrentRegistry>,
): Promise<CurrentRegistry> => {
  const filePath = cachePathFor(ORIGIN, env);
  const file = {
    version: CACHE_SCHEMA_VERSION,
    serverOrigin: ORIGIN,
    fetchedAt: new Date().toISOString(),
    ttlSeconds: 86_400,
    toolsListHash: "h",
    listings: [listing("list_matters")],
    delta: { added: [], removed: [], changed: [] },
    ...over,
  };
  await writeCacheFile(filePath, file);
  return file;
};

describe("resolveCommandTree (S5.3)", () => {
  test("feature admission projects the caller tree without reporting registry drift", async () => {
    const env = await makeCacheEnv();
    const toolName = "save_time_entry";
    const spec = curatedLeavesForTool(generatedRouteMap, toolName).at(0);
    if (spec?.featureId === undefined) {
      panic("Missing real feature-gated command fixture");
    }
    const bakedTree = { kind: "leaf", spec } as const satisfies RouteNode;
    const registry = await writeCache(env, {
      listings: [
        {
          ...listing(toolName),
          featureId: spec.featureId,
          inputSchema: spec.inputSchema,
        },
      ],
      delta: { added: [], removed: [], changed: [] },
    });
    for (const featureAccess of [
      undefined,
      { capabilities: [], tools: [] },
      admittedFeatures,
    ]) {
      const resolved = await resolveCommandTree({
        serverOrigin: ORIGIN,
        env,
        registry,
        bakedTree,
        ...(featureAccess === undefined ? {} : { featureAccess }),
      });
      const visible = curatedLeavesForTool(resolved.tree, toolName);
      expect(visible.length).toBe(featureAccess === admittedFeatures ? 1 : 0);
      if (featureAccess === admittedFeatures) {
        expect(visible.at(0)?.featureId).toBe(spec.featureId);
        expect(visible.at(0)?.inputSchema).toEqual(spec.inputSchema);
      }
      expect(resolved.drift).toBeUndefined();
    }
  });

  test("fresh admission metadata retains every emitted capability for an enrolled and granted caller", async () => {
    const env = await makeCacheEnv();
    const snapshot = validateFetchedToolsList(
      await Bun.file(
        new URL("generated/registry-snapshot.json", import.meta.url),
      ).text(),
    );
    if (!snapshot.ok) {
      panic(`Invalid committed refresh-test registry: ${snapshot.violation}`);
    }
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "admitted-caller",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
      bakedListings: snapshot.listings,
      fetchRaw: okFetch(
        JSON.stringify({
          result: {
            tools: snapshot.listings.map((entry) => {
              const featureId = generatedToolAnnotations[entry.name]?.featureId;
              return {
                ...entry,
                ...(featureId === undefined ? {} : { _meta: { featureId } }),
              };
            }),
            _meta: { featureAccess: admittedFeatures },
          },
        }),
      ),
    });
    if (outcome.status !== "refreshed") {
      panic("Expected authenticated refresh fixture");
    }
    expect(outcome.featureAccess).toEqual(admittedFeatures);
    const resolved = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry: outcome.registry,
      ...(outcome.featureAccess === undefined
        ? {}
        : { featureAccess: outcome.featureAccess }),
    });
    expect(capabilityLeafIds(resolved.tree).toSorted()).toEqual(
      capabilityLeafIds(generatedRouteMap).toSorted(),
    );
    expect(resolved.drift).toBeUndefined();
  });

  test("no cache -> baked-in tree, no drift", async () => {
    const env = await makeCacheEnv();
    const { tree, drift, disabled } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
    expect(drift).toBeUndefined();
    expect(disabled).toEqual({ tools: [], capabilities: [] });
  });

  test("feature-omitted tools and capabilities are reported as disabled for help and tools list", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      featureOmittedTools: ["search_case_law", "get_usage"],
      featureOmittedCapabilities: ["usage.entitlement.get"],
    });
    const { tree, disabled } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
    expect(disabled).toEqual({
      tools: ["search_case_law", "get_usage"],
      capabilities: ["usage.entitlement.get"],
    });
  });

  test("empty delta -> baked-in tree", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      delta: { added: [], removed: [], changed: [] },
    });
    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
    expect(drift).toBeUndefined();
  });

  test("non-empty delta -> current-listings tree + the delta to report", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    expect(tree).not.toBe(generatedRouteMap);
    // Handed back whole: how much of it anyone sees is `registry-drift.ts`'s
    // decision, so this path never formats or truncates it.
    expect(drift).toEqual({
      added: ["list_widgets"],
      removed: [],
      changed: [],
    });
  });

  test("a rebuilt (diverged) tree still carries the capability leaves", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    expect(tree).not.toBe(generatedRouteMap);
    // The fetched curated tool is present...
    expect(countLeavesOfKind(tree, "leaf")).toBeGreaterThan(0);
    // Registry divergence preserves ordinary capability leaves; feature
    // commands require this invocation's authenticated projection.
    const capabilityLeaves = countLeavesOfKind(tree, "capability-leaf");
    expect(capabilityLeaves).toBe(
      capabilityLeafIds(generatedRouteMap).filter(
        (id) => !gatedCapabilityIds.has(id),
      ).length,
    );
    expect(capabilityLeaves).toBeGreaterThan(200);
  });

  test("a scoped refresh retains baked compound commands for local preflight", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      // Models a default read/search token: tools that require neither grant
      // are absent from the server's authorization-projected listing.
      listings: [listing("list_matters")],
      delta: {
        added: [],
        removed: ["save_filled_template"],
        changed: [],
      },
      scopeOmittedTools: ["save_filled_template"],
    });

    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    const retained = curatedLeavesForTool(tree, "save_filled_template");

    expect(retained).toHaveLength(2);
    expect(
      retained.map(({ additionalScopes, scope }) => ({
        additionalScopes,
        scope,
      })),
    ).toEqual([
      { additionalScopes: ["templates"], scope: "documents_write" },
      { additionalScopes: ["templates"], scope: "documents_write" },
    ]);
  });

  test("a single-scope omission prunes the command without reporting drift", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      // `save_document` needs only `documents_write`, so there is no local
      // all-scopes preflight to keep reachable: the token cannot call it.
      listings: [listing("list_matters")],
      delta: { added: [], removed: [], changed: [] },
      scopeOmittedTools: ["save_document"],
    });

    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(tree).not.toBe(generatedRouteMap);
    expect(curatedLeavesForTool(tree, "save_document")).toHaveLength(0);
    // The registry itself did not diverge, so nothing to report.
    expect(drift).toBeUndefined();
  });

  test("a compound-only scope omission keeps the baked tree", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_matters")],
      delta: { added: [], removed: [], changed: [] },
      scopeOmittedTools: ["save_filled_template"],
    });

    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
    expect(drift).toBeUndefined();
  });

  test("a feature-gated command stays in a diverged tree so the server can answer it", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_matters"), listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
      // `search_case_law` is baked but gated off in this deployment. Keeping the
      // command means invoking it returns the server's feature_disabled with its
      // real message, instead of the CLI claiming there is no such command.
      featureOmittedTools: ["search_case_law"],
    });

    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(
      curatedLeavesForTool(tree, "search_case_law").length,
    ).toBeGreaterThan(0);
  });

  test("a fully authorized omission does not restore a removed compound tool", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_matters")],
      delta: {
        added: [],
        removed: ["save_filled_template"],
        changed: [],
      },
      scopeOmittedTools: [],
    });

    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(curatedLeavesForTool(tree, "save_filled_template")).toHaveLength(0);
  });

  test("an unattested omission does not restore a compound tool", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_matters")],
      delta: {
        added: [],
        removed: ["save_filled_template"],
        changed: [],
      },
    });

    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(curatedLeavesForTool(tree, "save_filled_template")).toHaveLength(0);
  });

  test("grants-only evidence from an older server does not restore an unsupported tool", async () => {
    const env = await makeCacheEnv();
    const registry = await writeCache(env, {
      listings: [listing("list_matters")],
      delta: {
        added: [],
        removed: ["save_filled_template"],
        changed: [],
      },
      grantedScopes: ["stella:read", "stella:search"],
    });

    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });

    expect(curatedLeavesForTool(tree, "save_filled_template")).toHaveLength(0);
  });

  test("provenance pin: a cache for a different origin is ignored (rule 5)", async () => {
    const env = await makeCacheEnv();
    // Write a file whose stored origin differs from the one we resolve for.
    const registry = await writeCache(env, {
      serverOrigin: "https://other.example",
      listings: [listing("list_widgets")],
      delta: { added: ["list_widgets"], removed: [], changed: [] },
    });
    // The cache path is keyed by ORIGIN's hash, so plant the mismatched file there.
    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry,
    });
    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
    expect(drift).toBeUndefined();
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

  test("an unreadable cache left by an older schema version is refreshed, not skipped", async () => {
    const env = await makeCacheEnv();
    await writeCache(env, {});
    const filePath = cachePathFor(ORIGIN, env);
    // Simulate a file written by a CLI with a previous cache schema version.
    await writeFile(
      filePath,
      JSON.stringify({
        version: CACHE_SCHEMA_VERSION - 1,
        serverOrigin: ORIGIN,
      }),
    );
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters"])),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: true });
    const written = await readCacheFile(filePath);
    expect(written?.version).toBe(CACHE_SCHEMA_VERSION);
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
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters", "list_widgets"]), {
        grantedScopes: ["stella:read", "stella:search"],
        scopeOmittedTools: ["save_filled_template"],
      }),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: false });
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    expect(written?.serverOrigin).toBe(ORIGIN);
    if (outcome.status !== "refreshed") {
      throw new Error("Expected fresh registry");
    }
    expect(outcome.registry.delta.added).toEqual(["list_widgets"]);
    expect(outcome.registry.grantedScopes).toEqual([
      "stella:read",
      "stella:search",
    ]);
    expect(outcome.registry.scopeOmittedTools).toEqual([
      "save_filled_template",
    ]);
    expect(outcome.registry.toolsListHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(written).not.toHaveProperty("listings");
    expect(written).not.toHaveProperty("grantedScopes");
  });

  test("an attested deployment-gated projection reconciles to an empty delta", async () => {
    const env = await makeCacheEnv();
    // The shape a deployment with its feature flags off serves: the baked tools
    // are absent from tools/list, and the response attests why. Without that
    // evidence they read as removals and drift is reported on every invocation.
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters"]), {
        grantedScopes: ["stella:read", "stella:search"],
        scopeOmittedTools: [],
        featureOmittedTools: ["list_time_entries", "search_case_law"],
        featureOmittedCapabilities: ["time-entries.csv.export"],
      }),
      bakedListings: [
        listing("list_matters"),
        listing("list_time_entries"),
        listing("search_case_law"),
      ],
    });

    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: true });
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    expect(written).not.toHaveProperty("delta");
    expect(written?.featureOmittedTools).toEqual([
      "list_time_entries",
      "search_case_law",
    ]);
    expect(written?.featureOmittedCapabilities).toEqual([
      "time-entries.csv.export",
    ]);
    const { tree, drift } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
    });
    expect(drift).toBeUndefined();
    expect(tree).toEqual(
      projectFeatureCommands({
        tree: generatedRouteMap,
        featureAccess: undefined,
      }),
    );
  });

  test("an unattested absence is still a removal (older self-hosted server)", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters"])),
      bakedListings: [listing("list_matters"), listing("search_case_law")],
    });

    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: false });
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    if (outcome.status !== "refreshed") {
      throw new Error("Expected fresh registry");
    }
    expect(outcome.registry.delta.removed).toEqual(["search_case_law"]);
    expect(written).not.toHaveProperty("delta");
  });

  test("empty delta still refreshes (fetchedAt bumped) with deltaEmpty=true", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters"])),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: true });
  });

  test("fail closed: an invalid body is rejected and NOT written (rule 6)", async () => {
    const env = await makeCacheEnv();
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
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
      fetchLatestVersion: async () => undefined,
      fetchRaw: errFetch(),
      bakedListings: [listing("list_matters")],
    });
    expect(outcome.status).toBe("failed");
    expect(await readCacheFile(cachePathFor(ORIGIN, env))).toBeUndefined();
  });

  test("unknown fetched tools flow through the SAME generateRouteMap heuristics", async () => {
    const env = await makeCacheEnv();
    // A validated but unannotated tool: the current-listings tree must place it
    // via the S1 verb/domain heuristic (list_widgets -> `widgets list`).
    const outcome = await refreshRegistryCache({
      serverOrigin: ORIGIN,
      token: "t",
      env,
      force: true,
      fetchLatestVersion: async () => undefined,
      fetchRaw: okFetch(toolsBody(["list_matters", "list_widgets"])),
      bakedListings: [listing("list_matters")],
    });
    if (outcome.status !== "refreshed") {
      throw new Error("Expected fresh registry");
    }
    const { tree } = await resolveCommandTree({
      serverOrigin: ORIGIN,
      env,
      registry: outcome.registry,
    });
    expect(tree.kind).toBe("route");
    if (tree.kind === "route") {
      const widgets = tree.children["widgets"];
      expect(widgets?.kind).toBe("route");
    }
  });
});

describe("CLI update nudge (spec 051 addendum)", () => {
  const refreshWith = async (over: {
    cliMinimum?: string;
    currentVersion: string;
    lastNudged?: string;
    npmLatest?: string;
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
          ...(over.cliMinimum === undefined
            ? {}
            : { cliMinimum: over.cliMinimum }),
        }),
        fetchLatestVersion: async () => over.npmLatest,
        bakedListings: [listing("list_matters")],
      }),
    };
  };

  test("a newer npm-published version prints exactly one nudge line", async () => {
    const { outcome, env } = await refreshWith({
      currentVersion: "0.1.0",
      npmLatest: "0.2.0",
    });
    expect(outcome).toMatchObject({
      status: "refreshed",
      deltaEmpty: true,
      nudge: "stella 0.1.0 -> 0.2.0 available; npm i -g @stll/cli",
    });
    // The anti-nag key is persisted for the next refresh.
    const written = await readCacheFile(cachePathFor(ORIGIN, env));
    expect(written?.lastNudgedVersion).toBe("0.2.0");
  });

  test("the same or an older published version is silent", async () => {
    const same = await refreshWith({
      currentVersion: "0.2.0",
      npmLatest: "0.2.0",
    });
    expect(same.outcome).toMatchObject({
      status: "refreshed",
      deltaEmpty: true,
    });
    const older = await refreshWith({
      currentVersion: "0.3.0",
      npmLatest: "0.2.0",
    });
    expect(older.outcome).toMatchObject({
      status: "refreshed",
      deltaEmpty: true,
    });
  });

  test("a malformed published version is silent (fail-silent parse)", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      npmLatest: "not-a-version",
    });
    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: true });
  });

  test("a minimum above the current version warns it is unsupported", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      npmLatest: "0.3.0",
      cliMinimum: "0.2.0",
    });
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") {
      expect(outcome.nudge).toBe(
        "stella 0.1.0 is no longer supported (server requires >= 0.2.0); upgrade with: npm i -g @stll/cli",
      );
    }
  });

  test("an unsupported version still warns when npm is unreachable", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      cliMinimum: "0.2.0",
    });
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") {
      expect(outcome.nudge).toContain("no longer supported");
    }
  });

  test("anti-nag: the version already nudged is not nudged again within TTL", async () => {
    const { outcome } = await refreshWith({
      currentVersion: "0.1.0",
      npmLatest: "0.2.0",
      lastNudged: "0.2.0",
    });
    expect(outcome).toMatchObject({ status: "refreshed", deltaEmpty: true });
  });
});
