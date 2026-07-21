import { describe, expect, test } from "bun:test";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
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

  test("flags with distinct spellings but one parser key are part-prefixed", () => {
    // Stricli's allow-kebab-for-camel scanner normalizes both public spellings
    // to `userId`. The generator must resolve the parser identity collision,
    // not merely compare the rendered flag strings.
    const { spec, flagCollisions } = deriveCapabilityLeaf(
      entry({
        id: "users.compare",
        handlerKind: "root",
        inputSchema: {
          body: objectSchema({
            user: objectSchema({ id: { type: "string" } }),
          }),
          query: objectSchema({ user_id: { type: "string" } }),
        },
      }),
    );

    expect(flagByCli(spec, "--user.id")).toBeUndefined();
    expect(flagByCli(spec, "--user-id")).toBeUndefined();
    expect(flagByCli(spec, "--body-user-id")?.partPath).toBe("user.id");
    expect(flagByCli(spec, "--query-user-id")?.partPath).toBe("user_id");
    expect(flagCollisions).toEqual(["--body-user-id", "--query-user-id"]);
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

/**
 * Namespaces where a curated, hand-written command still shares a top-level name
 * with generated capability commands. Each entry means a caller typing
 * `stella <namespace> …` cannot tell whether they get a named MCP tool or the
 * generic `invoke_capability` path — the exact drift this guard exists to stop.
 *
 * The list may only SHRINK: it is seeded with the four namespaces that were
 * already split when the guard landed, and is ratcheted by
 * `cli-shadowed-namespaces` in `scripts/ratchet.ts`. Adding a curated command in
 * a namespace a capability occupies fails this test rather than silently landing.
 */
const SHADOWED_NAMESPACE_ALLOWLIST: readonly string[] = [
  "capability",
  "case-law",
  "legislation",
  "usage",
];

/**
 * Capabilities whose natural command path is taken by a curated command, so they
 * are relocated under `stella capability <domain> <action>`. A relocation is a
 * symptom of the same shadowing problem, so it is pinned rather than merely counted.
 */
const COLLISION_FALLBACK_ALLOWLIST: readonly string[] = ["legislation.search"];

describe("curated commands must not shadow capability commands", () => {
  const namespacesByKind = (node: RouteNode) => {
    const curated = new Set<string>();
    const capability = new Set<string>();
    const walk = (current: RouteNode, path: readonly string[]): void => {
      if (current.kind === "route") {
        for (const [segment, child] of Object.entries(current.children)) {
          walk(child, [...path, segment]);
        }
        return;
      }
      const top = path.at(0);
      if (top === undefined) {
        return;
      }
      (current.kind === "leaf" ? curated : capability).add(top);
    };
    walk(node, []);
    return { capability, curated };
  };

  test("no curated command occupies a namespace a capability occupies", async () => {
    const catalog: CapabilityCatalogEntry[] = await Bun.file(
      new URL("generated/capability-catalog.json", import.meta.url),
    ).json();
    const listings = await Bun.file(
      new URL("generated/registry-snapshot.json", import.meta.url),
    ).json();
    const { tree, stats } = insertCapabilities({
      entries: catalog,
      tree: generateRouteMap(listings, TOOL_ANNOTATIONS),
    });
    const { capability, curated } = namespacesByKind(tree);
    const shadowed = [...curated].filter((ns) => capability.has(ns)).sort();

    expect(shadowed).toEqual([...SHADOWED_NAMESPACE_ALLOWLIST].sort());
    expect([...stats.collisionFallbacks].sort()).toEqual(
      [...COLLISION_FALLBACK_ALLOWLIST].sort(),
    );
  });
});

// Guard for the flag <-> --input drift class: a value flag routes its value into
// `input[part]` at `partPath` (setPath in the executors), and `--input` is
// validated against the synthesized wrapper schema. If a flag's target path is
// not a real path in that schema, the flag and the JSON key silently diverge --
// exactly the trap the compose fix removes. Assert every generated flag's
// `${part}.${partPath}` resolves to a declared property in the leaf's wrapper
// schema, so drift fails CI instead of shipping.
describe("every capability flag maps to a real path in its wrapper schema", () => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const pathResolves = (
    wrapper: Record<string, unknown>,
    part: string,
    partPath: string,
  ): boolean => {
    const topProperties = wrapper["properties"];
    if (!isRecord(topProperties)) {
      return false;
    }
    let node: unknown = topProperties[part];
    for (const segment of partPath.split(".")) {
      if (!isRecord(node)) {
        return false;
      }
      const properties = node["properties"];
      if (!isRecord(properties)) {
        return false;
      }
      node = properties[segment];
      if (node === undefined) {
        return false;
      }
    }
    return true;
  };

  test("no flag targets a path absent from the wrapper schema", async () => {
    const raw: unknown = await Bun.file(
      new URL("generated/capability-catalog.json", import.meta.url),
    ).json();
    const entries = parseCapabilityCatalog(raw);
    expect(entries).not.toBeNull();

    const drift: string[] = [];
    for (const catalogEntry of entries ?? []) {
      const { spec } = deriveCapabilityLeaf(catalogEntry);
      if (spec.inputSchema === undefined) {
        // Truncated entry: no flags, `--input` only.
        expect(spec.flags).toHaveLength(0);
        continue;
      }
      for (const flag of spec.flags) {
        if (!pathResolves(spec.inputSchema, flag.part, flag.partPath)) {
          drift.push(
            `${spec.capabilityId}: ${flag.flag} -> ${flag.part}.${flag.partPath}`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });
});
