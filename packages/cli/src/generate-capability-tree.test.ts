import { describe, expect, test } from "bun:test";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import {
  type CapabilityCatalogEntry,
  capabilityCommandPath,
  deriveCapabilityLeaf,
  insertCapabilities,
} from "./generate-capability-tree.js";
import { generateRouteMap } from "./generate-route-map.js";
import type {
  CapabilityFlagSpec,
  CapabilityLeafSpec,
  RouteNode,
} from "./route-types.js";

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const entry = (
  overrides: Partial<CapabilityCatalogEntry> & { id: string },
): CapabilityCatalogEntry => ({
  handlerKind: "root",
  access: "read",
  destructive: false,
  scope: "stella:read",
  ...overrides,
});

const flagByCli = (
  spec: CapabilityLeafSpec,
  flag: string,
): CapabilityFlagSpec | undefined => spec.flags.find((f) => f.flag === flag);

const leafAt = (
  tree: RouteNode,
  path: readonly string[],
): CapabilityLeafSpec | undefined => {
  let node: RouteNode = tree;
  for (const segment of path) {
    if (node.kind !== "route") {
      return undefined;
    }
    const next = node.children[segment];
    if (next === undefined) {
      return undefined;
    }
    node = next;
  }
  return node.kind === "capability-leaf" ? node.spec : undefined;
};

describe("capabilityCommandPath", () => {
  test("kebab-cases each dotted segment, including a camelCase leaf", () => {
    expect(capabilityCommandPath("time-entries.create")).toEqual([
      "time-entries",
      "create",
    ]);
    expect(capabilityCommandPath("skills.resources.upload")).toEqual([
      "skills",
      "resources",
      "upload",
    ]);
    expect(
      capabilityCommandPath(
        "entities.legacy-summaries.readLegacySummariesCount",
      ),
    ).toEqual(["entities", "legacy-summaries", "read-legacy-summaries-count"]);
  });
});

describe("deriveCapabilityLeaf: flags", () => {
  test("scalar body props become bare flags routed to input.body", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "billing-codes.create",
        handlerKind: "root",
        inputSchema: {
          body: objectSchema(
            { code: { type: "string" }, active: { type: "boolean" } },
            ["code"],
          ),
        },
      }),
    );
    const code = flagByCli(spec, "--code");
    expect(code?.part).toBe("body");
    expect(code?.partPath).toBe("code");
    expect(code?.required).toBe(true);
    expect(flagByCli(spec, "--active")?.part).toBe("body");
  });

  test("a cross-part name collision part-prefixes both flags", () => {
    const { spec, flagCollisions } = deriveCapabilityLeaf(
      entry({
        id: "entities.compare-versions",
        handlerKind: "root",
        inputSchema: {
          params: objectSchema({ entityId: { type: "string" } }),
          body: objectSchema({ entityId: { type: "string" } }),
        },
      }),
    );
    expect(flagByCli(spec, "--entity-id")).toBeUndefined();
    const paramFlag = flagByCli(spec, "--params-entity-id");
    const bodyFlag = flagByCli(spec, "--body-entity-id");
    expect(paramFlag?.partPath).toBe("entityId");
    expect(paramFlag?.part).toBe("params");
    expect(bodyFlag?.part).toBe("body");
    expect(flagCollisions).toEqual(["--params-entity-id", "--body-entity-id"]);
  });

  test("a reserved-flag collision (version) is part-prefixed", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "skills.update",
        handlerKind: "root",
        inputSchema: { body: objectSchema({ version: { type: "string" } }) },
      }),
    );
    expect(flagByCli(spec, "--version")).toBeUndefined();
    expect(flagByCli(spec, "--body-version")?.partPath).toBe("version");
  });

  test("a part-prefixed flag colliding with another part's natural name prefixes both", () => {
    // query.version -> reserved -> --query-version; body.queryVersion would
    // naturally kebab to --query-version too. Global uniqueness must prefix
    // the body candidate as well, never ship two flags with one name.
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "a.b",
        handlerKind: "root",
        inputSchema: {
          query: objectSchema({ version: { type: "string" } }),
          body: objectSchema({ queryVersion: { type: "string" } }),
        },
      }),
    );
    const names = spec.flags.map((f) => f.flag);
    expect(new Set(names).size).toBe(names.length);
    expect(flagByCli(spec, "--query-version")?.part).toBe("query");
    expect(flagByCli(spec, "--body-query-version")?.part).toBe("body");
  });

  test("a prop colliding with the synthetic --workspace is part-prefixed", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "a.b",
        handlerKind: "workspace",
        inputSchema: { body: objectSchema({ workspace: { type: "string" } }) },
      }),
    );
    const workspaceFlags = spec.flags.filter((f) => f.flag === "--workspace");
    expect(workspaceFlags).toHaveLength(1);
    expect(workspaceFlags[0]?.partPath).toBe("workspaceId");
    expect(flagByCli(spec, "--body-workspace")?.partPath).toBe("workspace");
  });

  test("an irresolvable duplicate fails generation naming the capability", () => {
    // body.fooBar and body.foo_bar both kebab to --foo-bar, and their prefixed
    // forms (--body-foo-bar) still collide: generation must fail, not ship an
    // ambiguous flag surface.
    expect(() =>
      deriveCapabilityLeaf(
        entry({
          id: "a.irresolvable",
          handlerKind: "root",
          inputSchema: {
            body: objectSchema({
              fooBar: { type: "string" },
              foo_bar: { type: "string" },
            }),
          },
        }),
      ),
    ).toThrow(/a\.irresolvable.*--body-foo-bar/u);
  });
});

describe("deriveCapabilityLeaf: workspace flag", () => {
  test("a workspace entry missing params.workspaceId gets a required --workspace", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "billing-codes.create",
        handlerKind: "workspace",
        inputSchema: { body: objectSchema({ code: { type: "string" } }) },
      }),
    );
    const workspace = flagByCli(spec, "--workspace");
    expect(workspace?.required).toBe(true);
    expect(workspace?.part).toBe("params");
    expect(workspace?.partPath).toBe("workspaceId");
    // The synthesized schema accepts params.workspaceId for the --input path.
    expect(JSON.stringify(spec.inputSchema)).toContain("workspaceId");
  });

  test("a workspace entry already declaring workspaceId gets no synthetic flag", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "entities.rename",
        handlerKind: "workspace",
        inputSchema: {
          params: objectSchema({ workspaceId: { type: "string" } }, [
            "workspaceId",
          ]),
        },
      }),
    );
    expect(flagByCli(spec, "--workspace")).toBeUndefined();
    expect(flagByCli(spec, "--workspace-id")?.partPath).toBe("workspaceId");
  });
});

describe("deriveCapabilityLeaf: pagination + suppression + truncation", () => {
  test("a query part with cursor+limit paginates and drops those flags", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "contacts.read",
        handlerKind: "workspace",
        inputSchema: {
          query: objectSchema({
            cursor: { type: "string" },
            limit: { type: "integer" },
            active: { type: "boolean" },
          }),
        },
      }),
    );
    expect(spec.paginated).toBe(true);
    expect(spec.paginationPart).toBe("query");
    expect(spec.itemsKey).toBe("items");
    expect(flagByCli(spec, "--cursor")).toBeUndefined();
    expect(flagByCli(spec, "--limit")).toBeUndefined();
    expect(flagByCli(spec, "--active")).toBeDefined();
  });

  test("a truncated entry yields no flags and --input only", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "views.create",
        handlerKind: "workspace",
        inputSchemaTruncated: true,
      }),
    );
    expect(spec.flags).toHaveLength(0);
    expect(spec.schemaTruncated).toBe(true);
    expect(spec.inputSchema).toBeUndefined();
  });

  test("scope maps stella:* to a ToolScope, else undefined", () => {
    expect(
      deriveCapabilityLeaf(entry({ id: "a.b", scope: "stella:matters_write" }))
        .spec.scope,
    ).toBe("matters_write");
    // No CLI ToolScope for stella:skills -> no client precheck.
    expect(
      deriveCapabilityLeaf(entry({ id: "a.b", scope: "stella:skills" })).spec
        .scope,
    ).toBeUndefined();
  });
});

describe("insertCapabilities: merge + collisions", () => {
  test("suppresses file-input/output entries but generates the rest", () => {
    const { stats } = insertCapabilities({
      tree: { kind: "route", children: {} },
      entries: [
        entry({ id: "a.read" }),
        entry({ id: "b.upload", requiresFileInput: true }),
        entry({ id: "c.export", returnsFileResponse: true }),
      ],
    });
    expect(stats.generated).toBe(1);
    expect(stats.suppressed).toBe(2);
    expect(stats.suppressedIds).toEqual(["b.upload", "c.export"]);
  });

  test("a curated command wins; the capability drops under `capability ...`", () => {
    // Curated tree already owns `legislation search`.
    const curated: RouteNode = {
      kind: "route",
      children: {
        legislation: {
          kind: "route",
          children: {
            search: {
              kind: "leaf",
              spec: {
                commandPath: ["legislation", "search"],
                toolName: "search_legislation",
                flags: [],
                inputOnly: [],
                paginated: false,
                windowedText: false,
                destructive: false,
                inputSchema: { type: "object", properties: {} },
              },
            },
          },
        },
      },
    };
    const { tree, stats } = insertCapabilities({
      tree: curated,
      entries: [entry({ id: "legislation.search" })],
    });
    expect(stats.collisionFallbacks).toEqual(["legislation.search"]);
    // Curated leaf untouched.
    expect(leafAt(tree, ["legislation", "search"])).toBeUndefined();
    // Capability relocated under the `capability` group.
    expect(
      leafAt(tree, ["capability", "legislation", "search"])?.capabilityId,
    ).toBe("legislation.search");
  });

  test("a capability that is a prefix of another falls back rather than clobbering", () => {
    const { tree, stats } = insertCapabilities({
      tree: { kind: "route", children: {} },
      entries: [
        entry({ id: "entities.read-summaries" }),
        entry({ id: "entities.read-summaries.count" }),
      ],
    });
    expect(leafAt(tree, ["entities", "read-summaries"])?.capabilityId).toBe(
      "entities.read-summaries",
    );
    expect(stats.collisionFallbacks).toContain("entities.read-summaries.count");
    expect(
      leafAt(tree, ["capability", "entities", "read-summaries", "count"])
        ?.capabilityId,
    ).toBe("entities.read-summaries.count");
  });
});

describe("insertCapabilities: against the real curated tree + catalog", () => {
  test("merges the committed catalog with the expected shape", async () => {
    const catalogUrl = new URL(
      "generated/capability-catalog.json",
      import.meta.url,
    );
    const snapshotUrl = new URL(
      "generated/registry-snapshot.json",
      import.meta.url,
    );
    const catalog: CapabilityCatalogEntry[] = await Bun.file(catalogUrl).json();
    const listings = await Bun.file(snapshotUrl).json();
    const curated = generateRouteMap(listings, TOOL_ANNOTATIONS);
    const { stats } = insertCapabilities({
      tree: curated,
      entries: catalog,
    });
    const suppressed = catalog.filter(
      (e) => e.requiresFileInput === true || e.returnsFileResponse === true,
    ).length;
    expect(stats.suppressed).toBe(suppressed);
    expect(stats.generated).toBe(catalog.length - suppressed);
  });
});
