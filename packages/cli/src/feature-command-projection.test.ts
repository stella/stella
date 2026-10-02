import { run } from "@stricli/core";
import { panic, Result } from "better-result";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildApp } from "./build-cli-tree.js";
import {
  loadBakedCapabilityCatalog,
  parseCapabilityCatalog,
} from "./capability-catalog-load.js";
import {
  hasFeatureCommands,
  projectFeatureCommands,
} from "./feature-command-projection.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { generatedToolAnnotations } from "./generated/tool-annotations.js";
import {
  cachePathFor,
  credentialFingerprint,
  readCacheFile,
} from "./registry-cache.js";
import {
  refreshRegistryCache,
  requiresFeatureAccessRefresh,
  resolveCommandTree,
} from "./registry-refresh.js";
import { validateFetchedToolsList } from "./registry-trust.js";
import type { RouteNode } from "./route-types.js";

const ORIGIN = "https://feature-projection.example";
const TEST_FEATURE = "fixture-feature";
const CAPABILITY = "usage.entitlement.get";
const TOOL = "get_usage";
const catalog = await loadBakedCapabilityCatalog();
if (catalog === null || !catalog.some((entry) => entry.id === CAPABILITY)) {
  throw new Error("Real catalog fixture is incomplete");
}
const entries = structuredClone(catalog);
for (const entry of entries) {
  if (entry.id === CAPABILITY) {
    entry.featureId = TEST_FEATURE;
    entry.featureAccess = "required";
  }
}
const rawSnapshot: unknown = await Bun.file(
  new URL("generated/registry-snapshot.json", import.meta.url),
).json();
const baked = validateFetchedToolsList(JSON.stringify(rawSnapshot));
if (!baked.ok || !baked.listings.some((listing) => listing.name === TOOL)) {
  throw new Error("Real tool fixture is incomplete");
}
const listings = structuredClone(baked.listings);
for (const listing of listings) {
  if (listing.name === TOOL) {
    listing.featureId = TEST_FEATURE;
  }
}
const toolAnnotation = generatedToolAnnotations[TOOL];
if (toolAnnotation === undefined) {
  throw new Error("Real tool annotation is missing");
}
const annotations = {
  ...generatedToolAnnotations,
  [TOOL]: { ...toolAnnotation, featureId: TEST_FEATURE },
};
const tree = buildCliRouteTree({ listings, entries, annotations }).tree;
const enabled = { capabilities: [CAPABILITY], tools: [TOOL] };
const hidden = { capabilities: [], tools: [] };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

const cacheEnv = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stella-feature-projection-"));
  dirs.push(dir);
  return { XDG_CACHE_HOME: dir };
};
const leafIds = (node: RouteNode): string[] => {
  switch (node.kind) {
    case "leaf":
      return [node.spec.toolName];
    case "capability-leaf":
      return [node.spec.capabilityId];
    case "route":
      return Object.values(node.children).flatMap(leafIds);
    default: {
      node satisfies never;
      return panic("Unexpected command node");
    }
  }
};
const invokeHelp = async (commandTree: RouteNode, argv: string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await run(buildApp(commandTree), argv, {
    forCommand: () => ({
      process,
      configDir: "",
      serverUrl: undefined,
      token: undefined,
    }),
    process: {
      stdout: {
        write: (text: string) => {
          stdout.push(text);
        },
      },
      stderr: {
        write: (text: string) => {
          stderr.push(text);
        },
      },
    },
  });
  return { stdout: stdout.join(""), stderr: stderr.join("") };
};
const body = (snapshot: typeof enabled | undefined) =>
  JSON.stringify({
    result: {
      tools: listings.map(({ featureId, ...listing }) => ({
        ...listing,
        ...(featureId === undefined ? {} : { _meta: { featureId } }),
      })),
      ...(snapshot === undefined ? {} : { _meta: { featureAccess: snapshot } }),
    },
  });

test("the real catalog parser and route generator preserve feature ownership", () => {
  const parsed = parseCapabilityCatalog(entries);
  expect(parsed?.find((entry) => entry.id === CAPABILITY)?.featureId).toBe(
    TEST_FEATURE,
  );
  expect(hasFeatureCommands(tree)).toBe(true);
  expect(leafIds(tree)).toContain(CAPABILITY);
  expect(leafIds(tree)).toContain(TOOL);
  const invalid = structuredClone(entries);
  for (const entry of invalid) {
    if (entry.id === CAPABILITY) {
      entry.featureId = "";
    }
  }
  expect(parseCapabilityCatalog(invalid)).toBeNull();
  const incomplete = structuredClone(entries);
  for (const entry of incomplete) {
    delete entry.featureAccess;
  }
  expect(parseCapabilityCatalog(incomplete)).toBeNull();
});

test("conditional catalog commands retain their ordinary projected schema without a snapshot", () => {
  const conditionalEntries = structuredClone(entries);
  for (const entry of conditionalEntries) {
    if (entry.id === CAPABILITY) {
      entry.featureAccess = "conditional";
    }
  }
  const parsed = parseCapabilityCatalog(conditionalEntries);
  if (parsed === null) {
    throw new Error("Conditional real catalog fixture is invalid");
  }
  expect(parsed.find((entry) => entry.id === CAPABILITY)?.featureAccess).toBe(
    "conditional",
  );
  const conditionalTree = buildCliRouteTree({
    listings: baked.listings,
    entries: parsed,
    annotations: generatedToolAnnotations,
  }).tree;
  expect(
    leafIds(
      projectFeatureCommands({
        tree: conditionalTree,
        featureAccess: undefined,
      }),
    ),
  ).toContain(CAPABILITY);
});

for (const featureAccess of [undefined, hidden]) {
  test(`a ${featureAccess === undefined ? "missing" : "hidden"} current snapshot prunes real commands and help`, async () => {
    const projected = projectFeatureCommands({ tree, featureAccess });
    const ids = leafIds(projected);
    expect(ids).not.toContain(CAPABILITY);
    expect(ids).not.toContain(TOOL);
    expect(ids).toContain("list_matters");
    const help = await invokeHelp(projected, ["capability", "usage", "--help"]);
    expect(help.stdout).not.toContain("entitlement-get");
    const suggestion = await invokeHelp(projected, [
      "capability",
      "usage",
      "entitlement-gte",
    ]);
    expect(suggestion.stderr).not.toContain("entitlement-get");
    const output: string[] = [];
    const writer = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        output.push(String(chunk));
        return true;
      },
    );
    try {
      await run(buildApp(projected), ["tools", "list"], {
        forCommand: () => ({
          process,
          configDir: "",
          serverUrl: undefined,
          token: undefined,
        }),
        process,
      });
    } finally {
      writer.mockRestore();
    }
    expect(output.join("")).not.toContain(CAPABILITY);
    expect(output.join("")).not.toContain(`(${TOOL})`);
  });
}

test("an enabled current snapshot permits the real commands and their help", async () => {
  const projected = projectFeatureCommands({ tree, featureAccess: enabled });
  expect(leafIds(projected)).toContain(CAPABILITY);
  expect(leafIds(projected)).toContain(TOOL);
  expect(
    (await invokeHelp(projected, ["capability", "usage", "--help"])).stdout,
  ).toContain("entitlement-get");
});

test("only a current authenticated response enables feature commands over the cache", async () => {
  const env = await cacheEnv();
  const outcome = await refreshRegistryCache({
    serverOrigin: ORIGIN,
    token: "caller-a",
    env,
    force: true,
    fetchLatestVersion: async () => undefined,
    fetchRaw: async () =>
      Result.ok({
        rawBody: body(enabled),
        featureOmittedTools: [TOOL],
        featureOmittedCapabilities: [CAPABILITY],
      }),
    bakedListings: listings,
  });
  expect(outcome.status).toBe("refreshed");
  if (outcome.status !== "refreshed") {
    throw new Error("Expected authenticated fixture response");
  }
  expect(outcome.featureAccess).toEqual(enabled);
  if (outcome.featureAccess === undefined) {
    throw new Error("Expected enabled fixture snapshot");
  }
  const file = await readCacheFile(cachePathFor(ORIGIN, env));
  expect(file?.credentialFingerprint).toBe(credentialFingerprint("caller-a"));
  expect(file).not.toHaveProperty("featureAccess");
  const args = {
    serverOrigin: ORIGIN,
    token: "caller-a",
    env,
    bakedTree: tree,
    loadCatalog: async () => entries,
    annotations,
  };
  const current = await resolveCommandTree({
    ...args,
    featureAccess: outcome.featureAccess,
  });
  expect(leafIds(current.tree)).toContain(CAPABILITY);
  const offline = await resolveCommandTree(args);
  expect(leafIds(offline.tree)).not.toContain(CAPABILITY);
  expect(leafIds(offline.tree)).not.toContain(TOOL);
  const denied = await resolveCommandTree({ ...args, featureAccess: hidden });
  expect(leafIds(denied.tree)).not.toContain(CAPABILITY);
  expect(leafIds(denied.tree)).not.toContain(TOOL);
  expect(
    await requiresFeatureAccessRefresh({ serverOrigin: ORIGIN, env }),
  ).toBe(true);
});

test("credential switches refresh ordinary cached scope and keep default feature projection hidden", async () => {
  const env = await cacheEnv();
  const fetchRaw = async () => Result.ok({ rawBody: body(enabled) });
  await refreshRegistryCache({
    serverOrigin: ORIGIN,
    token: "caller-a",
    env,
    force: true,
    fetchLatestVersion: async () => undefined,
    fetchRaw,
    bakedListings: listings,
  });
  let fetches = 0;
  const outcome = await refreshRegistryCache({
    serverOrigin: ORIGIN,
    token: "caller-b",
    env,
    fetchLatestVersion: async () => undefined,
    fetchRaw: async () => {
      fetches += 1;
      return Result.ok({ rawBody: body(hidden) });
    },
    bakedListings: listings,
  });
  expect(outcome.status).toBe("refreshed");
  expect(fetches).toBe(1);
  const resolved = await resolveCommandTree({
    serverOrigin: ORIGIN,
    token: "caller-b",
    env,
    bakedTree: tree,
    loadCatalog: async () => entries,
    annotations,
  });
  expect(leafIds(resolved.tree)).not.toContain(CAPABILITY);
  expect(leafIds(resolved.tree)).not.toContain(TOOL);
});

test("invalid feature metadata rejects fetched registry admission", () => {
  const raw: unknown = JSON.parse(body(enabled));
  expect(validateFetchedToolsList(JSON.stringify(raw)).ok).toBe(true);
  for (const featureAccess of [
    { tools: [], capabilities: "invalid" },
    { tools: ["Bad Tool"], capabilities: [] },
    null,
  ]) {
    expect(
      validateFetchedToolsList(
        JSON.stringify({ result: { tools: [], _meta: { featureAccess } } }),
      ),
    ).toEqual({ ok: false, violation: "feature access snapshot is invalid" });
  }
});
