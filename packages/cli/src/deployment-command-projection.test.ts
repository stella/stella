import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readCapabilityCatalog } from "./capability-catalog-data.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import { projectDeploymentCommands } from "./deployment-command-projection.js";
import { projectFeatureCommands } from "./feature-command-projection.js";
import {
  buildCliRouteTree,
  deriveCapabilityLeaf,
  isCatalogTransportInvocable,
} from "./generate-capability-tree.js";
import { generateRouteMap } from "./generate-route-map.js";
import registrySnapshot from "./generated/registry-snapshot.json" with { type: "json" };
import { generatedToolAnnotations } from "./generated/tool-annotations.js";
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_TTL_SECONDS,
  cachePathFor,
  writeCacheFile,
} from "./registry-cache.js";
import { resolveCommandTree } from "./registry-refresh.js";
import type { CurrentRegistry } from "./registry-refresh.js";
import { validateFetchedToolsList } from "./registry-trust.js";
import type { RouteNode } from "./route-types.js";

const rawCatalog = readCapabilityCatalog();
const catalog = parseCapabilityCatalog(rawCatalog);
if (catalog === null) {
  panic("Invalid committed deployment projection catalog");
}
const registry = validateFetchedToolsList(
  await Bun.file(
    new URL("generated/registry-snapshot.json", import.meta.url),
  ).text(),
);
if (!registry.ok) {
  panic("Invalid committed deployment projection registry");
}
const catalogTree = buildCliRouteTree({
  listings: registry.listings,
  entries: catalog,
  annotations: generatedToolAnnotations,
}).tree;
const leaves = (node: RouteNode): Exclude<RouteNode, { kind: "route" }>[] => {
  switch (node.kind) {
    case "leaf":
    case "capability-leaf":
      return [node];
    case "route":
      return Object.values(node.children).flatMap(leaves);
    default:
      node satisfies never;
      return panic("Unexpected command node");
  }
};
const ids = (node: RouteNode) =>
  leaves(node).map((leaf) =>
    leaf.kind === "leaf" ? leaf.spec.toolName : leaf.spec.capabilityId,
  );
const control = leaves(catalogTree)
  .filter((leaf) => leaf.kind === "leaf")
  .find(
    ({ spec }) =>
      spec.feature === undefined &&
      spec.featureId === undefined &&
      spec.toolName !== "list_matters",
  );
if (control === undefined) {
  panic("Deployment projection fixture needs an unrestricted sibling");
}
const featureEntry = catalog.find(
  (entry) =>
    entry.feature !== undefined && isCatalogTransportInvocable(entry.transport),
);
const toolAnnotation = generatedToolAnnotations["list_matters"];
if (featureEntry?.feature === undefined || toolAnnotation === undefined) {
  panic(
    "Deployment projection fixture has no canonical feature or curated annotation",
  );
}
const fixtureFeature = featureEntry.feature;
const capability = {
  kind: "capability-leaf",
  spec: deriveCapabilityLeaf({
    ...featureEntry,
    featureId: "fixture-feature",
    featureAccess: "required",
  }).spec,
} as const satisfies RouteNode;
const curated = generateRouteMap(
  [
    {
      name: "list_matters",
      description: "List matters",
      inputSchema: { type: "object" },
    },
  ],
  {
    list_matters: {
      ...toolAnnotation,
      feature: fixtureFeature,
      featureId: "fixture-feature",
    },
  },
);
const tool = leaves(curated).find((leaf) => leaf.kind === "leaf");
if (tool === undefined) {
  panic("Deployment projection fixture needs a curated command");
}
const fixtureTree = {
  kind: "route",
  children: { nested: { kind: "route", children: { tool, capability } } },
} as const satisfies RouteNode;
const fallbackTree = {
  kind: "route",
  children: { gated: fixtureTree, control },
} as const satisfies RouteNode;
const { featureId: _toolCaller, ...toolSpec } = tool.spec;
const { featureId: _capabilityCaller, ...capabilitySpec } = capability.spec;
const deploymentOnly = {
  kind: "route",
  children: {
    tool: { kind: "leaf", spec: toolSpec },
    capability: { kind: "capability-leaf", spec: capabilitySpec },
  },
} as const satisfies RouteNode;
const enabledCaller = {
  tools: ["list_matters"],
  capabilities: [featureEntry.id],
};
const noCallerGrant = { tools: [], capabilities: [] };
const ORIGIN = "https://deployment-projection.example";
const NOW = Date.parse("2026-01-02T12:00:00Z");
const dirs: string[] = [];
const cacheEnv = async () => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "stella-deployment-projection-"),
  );
  dirs.push(dir);
  return { XDG_CACHE_HOME: dir };
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});
const currentRegistry = (deploymentEnabled: boolean): CurrentRegistry => ({
  serverOrigin: ORIGIN,
  listings: [],
  delta: { added: [], removed: [], changed: [] },
  toolsListHash: "fixture",
  featureOmittedTools: deploymentEnabled ? [] : enabledCaller.tools,
  featureOmittedCapabilities: deploymentEnabled
    ? []
    : enabledCaller.capabilities,
});

describe("deployment command census", () => {
  test("every static tool deployment feature survives generation and hides off or unknown", () => {
    const declared = new Map<string, string>();
    for (const { name, cli } of registrySnapshot) {
      // An excluded tool generates no command, so it has no feature to carry.
      if ("excluded" in cli && cli.excluded) {
        continue;
      }
      if ("feature" in cli && typeof cli.feature === "string") {
        declared.set(name, cli.feature);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    const emitted = leaves(catalogTree).filter((leaf) => leaf.kind === "leaf");
    expect(
      new Set(
        emitted
          .filter((leaf) => leaf.spec.feature !== undefined)
          .map((leaf) => leaf.spec.toolName),
      ),
    ).toEqual(new Set(declared.keys()));
    for (const [name, feature] of declared) {
      const commands = emitted.filter((leaf) => leaf.spec.toolName === name);
      expect(commands.length).toBeGreaterThan(0);
      for (const { spec } of commands) {
        expect(spec.feature).toBe(feature);
      }
    }
    for (const featureOmittedTools of [undefined, [...declared.keys()]]) {
      const projected = projectDeploymentCommands({
        tree: catalogTree,
        featureOmittedTools,
        featureOmittedCapabilities: [],
      });
      expect(ids(projected).toSorted()).toEqual(
        leaves(catalogTree)
          .filter(
            (leaf) =>
              leaf.kind === "capability-leaf" ||
              !declared.has(leaf.spec.toolName),
          )
          .map((leaf) =>
            leaf.kind === "leaf" ? leaf.spec.toolName : leaf.spec.capabilityId,
          )
          .toSorted(),
      );
      expect(
        projectDeploymentCommands({
          tree: projected,
          featureOmittedTools,
          featureOmittedCapabilities: [],
        }),
      ).toEqual(projected);
    }
    expect(
      projectDeploymentCommands({
        tree: catalogTree,
        featureOmittedTools: [],
        featureOmittedCapabilities: [],
      }),
    ).toEqual(catalogTree);
  });

  test("every invocable catalog deployment feature survives parsing and hides off or unknown", () => {
    const declared = new Map<string, string>();
    for (const raw of rawCatalog) {
      if (
        typeof raw === "object" &&
        raw !== null &&
        "feature" in raw &&
        typeof raw.feature === "string" &&
        "id" in raw &&
        typeof raw.id === "string"
      ) {
        declared.set(raw.id, raw.feature);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect(
      new Map(
        catalog
          .filter((entry) => entry.feature !== undefined)
          .map((entry) => [entry.id, entry.feature]),
      ),
    ).toEqual(declared);
    const emitted = leaves(catalogTree).filter(
      (leaf) => leaf.kind === "capability-leaf",
    );
    const expected = catalog.filter(
      (entry) =>
        entry.feature !== undefined &&
        isCatalogTransportInvocable(entry.transport),
    );
    expect(
      emitted
        .filter((leaf) => leaf.spec.feature !== undefined)
        .map((leaf) => leaf.spec.capabilityId)
        .toSorted(),
    ).toEqual(expected.map((entry) => entry.id).toSorted());
    for (const entry of expected) {
      expect(
        emitted.find((leaf) => leaf.spec.capabilityId === entry.id)?.spec
          .feature,
      ).toBe(entry.feature);
    }
    for (const featureOmittedCapabilities of [
      undefined,
      expected.map((entry) => entry.id),
    ]) {
      const projected = projectDeploymentCommands({
        tree: catalogTree,
        featureOmittedTools: [],
        featureOmittedCapabilities,
      });
      for (const entry of expected) {
        expect(ids(projected)).not.toContain(entry.id);
      }
      expect(ids(projected).toSorted()).toEqual(
        ids(catalogTree)
          .filter((id) => !expected.some((entry) => entry.id === id))
          .toSorted(),
      );
      expect(
        projectDeploymentCommands({
          tree: projected,
          featureOmittedTools: [],
          featureOmittedCapabilities,
        }),
      ).toEqual(projected);
    }
    expect(
      projectDeploymentCommands({
        tree: catalogTree,
        featureOmittedTools: [],
        featureOmittedCapabilities: [],
      }),
    ).toEqual(catalogTree);
  });

  test("tool and capability evidence remain independent", () => {
    for (const [featureOmittedTools, featureOmittedCapabilities, expected] of [
      [undefined, [], [featureEntry.id]],
      [[], undefined, ["list_matters"]],
      [undefined, undefined, []],
      [[], [], ["list_matters", featureEntry.id]],
    ] as const) {
      const projected = projectDeploymentCommands({
        tree: fixtureTree,
        featureOmittedTools,
        featureOmittedCapabilities,
      });
      expect(ids(projected).toSorted()).toEqual([...expected].toSorted());
      if (expected.length === 0) {
        expect(projected).toEqual({ kind: "route", children: {} });
      }
    }
  });
});

describe("deployment and caller command admission", () => {
  for (const deploymentEnabled of [false, true]) {
    test.each([false, true])(
      `deployment ${deploymentEnabled} and caller grant %s decide both command kinds`,
      async (granted) => {
        const featureAccess = granted ? enabledCaller : noCallerGrant;
        const evidence = currentRegistry(deploymentEnabled);
        const resolved = await resolveCommandTree({
          serverOrigin: ORIGIN,
          env: await cacheEnv(),
          registry: evidence,
          featureAccess,
          bakedTree: fixtureTree,
          now: NOW,
        });
        expect(ids(resolved.tree).toSorted()).toEqual(
          deploymentEnabled && granted
            ? ["list_matters", featureEntry.id].toSorted()
            : [],
        );
        const callerFirst = projectDeploymentCommands({
          tree: projectFeatureCommands({ tree: fixtureTree, featureAccess }),
          featureOmittedTools: evidence.featureOmittedTools,
          featureOmittedCapabilities: evidence.featureOmittedCapabilities,
        });
        const deploymentFirst = projectFeatureCommands({
          tree: projectDeploymentCommands({
            tree: fixtureTree,
            featureOmittedTools: evidence.featureOmittedTools,
            featureOmittedCapabilities: evidence.featureOmittedCapabilities,
          }),
          featureAccess,
        });
        expect(resolved.tree).toEqual(callerFirst);
        expect(callerFirst).toEqual(deploymentFirst);
      },
    );
  }
});

describe("current deployment evidence", () => {
  test.each([
    "fresh",
    "expired",
    "other-origin",
    "missing",
    "no-origin",
  ] as const)("%s cache evidence decides tagged discovery", async (state) => {
    const env = await cacheEnv();
    if (state !== "missing") {
      await writeCacheFile(cachePathFor(ORIGIN, env), {
        version: CACHE_SCHEMA_VERSION,
        serverOrigin:
          state === "other-origin" ? "https://other.example" : ORIGIN,
        fetchedAt: new Date(
          NOW - (state === "expired" ? DEFAULT_TTL_SECONDS * 1000 + 1 : 0),
        ).toISOString(),
        ttlSeconds: DEFAULT_TTL_SECONDS,
        featureOmittedTools: [],
        featureOmittedCapabilities: [],
      });
    }
    const resolved = await resolveCommandTree({
      serverOrigin: state === "no-origin" ? undefined : ORIGIN,
      env,
      bakedTree: deploymentOnly,
      now: NOW,
    });
    expect(ids(resolved.tree).toSorted()).toEqual(
      state === "fresh" ? ["list_matters", featureEntry.id].toSorted() : [],
    );
    expect(resolved.drift).toBeUndefined();
  });

  test("cached deployment evidence supplies no caller grants", async () => {
    const env = await cacheEnv();
    await writeCacheFile(cachePathFor(ORIGIN, env), {
      version: CACHE_SCHEMA_VERSION,
      serverOrigin: ORIGIN,
      fetchedAt: new Date(NOW).toISOString(),
      ttlSeconds: DEFAULT_TTL_SECONDS,
      featureOmittedTools: [],
      featureOmittedCapabilities: [],
    });
    expect(
      ids(
        (
          await resolveCommandTree({
            serverOrigin: ORIGIN,
            env,
            bakedTree: fixtureTree,
            featureAccess: enabledCaller,
            now: NOW,
          })
        ).tree,
      ),
    ).toEqual([]);
    expect(
      ids(
        (
          await resolveCommandTree({
            serverOrigin: ORIGIN,
            env,
            registry: {
              ...currentRegistry(true),
              serverOrigin: "https://other.example",
            },
            bakedTree: fixtureTree,
            featureAccess: enabledCaller,
            now: NOW,
          })
        ).tree,
      ),
    ).toEqual([]);
  });

  test.each(
    (["catalog-unavailable", "invalid-command", "rebuilt"] as const).flatMap(
      (state) =>
        [false, true].map((deploymentEnabled) => ({
          state,
          deploymentEnabled,
        })),
    ),
  )(
    "$state resolution preserves deployment availability $deploymentEnabled",
    async ({ state, deploymentEnabled }) => {
      const evidence = {
        ...currentRegistry(deploymentEnabled),
        listings: registry.listings,
        delta: { added: ["fixture_tool"], removed: [], changed: [] },
      };
      const resolved = await resolveCommandTree({
        serverOrigin: ORIGIN,
        env: await cacheEnv(),
        registry: evidence,
        featureAccess: enabledCaller,
        bakedTree: fallbackTree,
        annotations:
          state === "invalid-command"
            ? { list_matters: { command: [] } }
            : {
                ...generatedToolAnnotations,
                list_matters: {
                  ...toolAnnotation,
                  feature: fixtureFeature,
                  featureId: "fixture-feature",
                },
              },
        loadCatalog: () =>
          state === "catalog-unavailable"
            ? null
            : [
                {
                  ...featureEntry,
                  featureId: "fixture-feature",
                  featureAccess: "required",
                },
              ],
        now: NOW,
      });
      expect(ids(resolved.tree).includes("list_matters")).toBe(
        deploymentEnabled,
      );
      expect(ids(resolved.tree).includes(featureEntry.id)).toBe(
        deploymentEnabled,
      );
      expect(ids(resolved.tree)).toContain(control.spec.toolName);
      if (state === "rebuilt") {
        expect(ids(resolved.tree)).toContain("save_document");
      }
    },
  );
});
