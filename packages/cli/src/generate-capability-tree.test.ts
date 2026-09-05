import { describe, expect, test } from "bun:test";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import {
  type CapabilityCatalogEntry,
  type CapabilityTransport,
  capabilityCommandPath,
  formatCapabilityCommand,
  deriveCapabilityLeaf,
  insertCapabilities,
  isTransportInvocable,
} from "./generate-capability-tree.js";
import {
  generateRouteMap,
  RouteGenerationError,
} from "./generate-route-map.js";
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
  inputSchema: {},
  transport: { type: "json" },
  ...overrides,
});

const fileInput = (field: string, required: boolean): CapabilityTransport => ({
  type: "file-input",
  input: { field, required },
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
  test("formats executable guidance from the same typed path", () => {
    expect(formatCapabilityCommand("uploads.update")).toBe(
      "stella capability uploads update",
    );
  });

  test("namespaces and kebab-cases every capability at a fixed depth", () => {
    expect(capabilityCommandPath("time-entries.create")).toEqual([
      "capability",
      "time-entries",
      "create",
    ]);
    expect(capabilityCommandPath("skills.resources.upload")).toEqual([
      "capability",
      "skills",
      "resources-upload",
    ]);
    expect(
      capabilityCommandPath(
        "entities.legacy-summaries.readLegacySummariesCount",
      ),
    ).toEqual([
      "capability",
      "entities",
      "legacy-summaries-read-legacy-summaries-count",
    ]);
  });

  test("rejects ids without both a domain and action", () => {
    expect(() => capabilityCommandPath("entities")).toThrow(
      /must contain a domain and action/u,
    );
    expect(() => capabilityCommandPath("entities..read")).toThrow(
      /must contain a domain and action/u,
    );
  });
});

describe("deriveCapabilityLeaf: flags", () => {
  test("property-less dynamic maps make the whole input part input-only", () => {
    const dynamicSchemas = [
      { type: "object", additionalProperties: { type: "string" } },
      {
        type: "object",
        patternProperties: { "^meta-": { type: "string" } },
      },
    ];

    for (const body of dynamicSchemas) {
      const { spec } = deriveCapabilityLeaf(
        entry({
          id: "metadata.replace",
          inputSchema: { body },
        }),
      );

      expect(spec.flags).toHaveLength(0);
      expect(spec.inputOnly).toEqual(["body"]);
    }
  });

  test("allOf-inherited dynamic maps make the whole input part input-only", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "metadata.replace",
        inputSchema: {
          body: {
            allOf: [
              {
                allOf: [
                  {
                    patternProperties: { "^meta-": { type: "string" } },
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(spec.flags).toHaveLength(0);
    expect(spec.inputOnly).toEqual(["body"]);
  });

  test("property-less oneOf bodies make the whole input part input-only", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "events.create",
        inputSchema: {
          body: {
            oneOf: [
              objectSchema({ type: { type: "string", const: "created" } }),
              objectSchema({ type: { type: "string", const: "deleted" } }),
            ],
          },
        },
      }),
    );

    expect(spec.inputOnly).toEqual(["body"]);
  });

  test("mixed alternative and dynamic-map bodies keep flags plus the input contract", () => {
    const mixedSchemas = [
      {
        ...objectSchema({ token: { type: "string" } }, ["token"]),
        anyOf: [
          objectSchema({ kind: { type: "string", const: "a" } }, ["kind"]),
        ],
      },
      {
        ...objectSchema({ token: { type: "string" } }, ["token"]),
        patternProperties: { "^meta-": { type: "string" } },
      },
    ];

    for (const body of mixedSchemas) {
      const { spec } = deriveCapabilityLeaf(
        entry({
          id: "events.create",
          inputSchema: { body },
        }),
      );

      expect(flagByCli(spec, "--token")).toBeDefined();
      expect(spec.inputOnly).toEqual(["body"]);
    }
  });

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

  test("a prop colliding with the synthetic --matter-id is part-prefixed", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "a.b",
        handlerKind: "workspace",
        inputSchema: { body: objectSchema({ matterId: { type: "string" } }) },
      }),
    );
    const matterFlags = spec.flags.filter((f) => f.flag === "--matter-id");
    expect(matterFlags).toHaveLength(1);
    expect(matterFlags[0]?.part).toBe("params");
    expect(matterFlags[0]?.partPath).toBe("matterId");
    expect(flagByCli(spec, "--body-matter-id")?.partPath).toBe("matterId");
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

describe("deriveCapabilityLeaf: matter flag", () => {
  test("a matter entry missing params.matterId gets a required --matter-id", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "billing-codes.create",
        handlerKind: "workspace",
        inputSchema: { body: objectSchema({ code: { type: "string" } }) },
      }),
    );
    const matter = flagByCli(spec, "--matter-id");
    expect(matter?.required).toBe(true);
    expect(matter?.part).toBe("params");
    expect(matter?.partPath).toBe("matterId");
    // The synthesized schema accepts params.matterId for the --input path.
    expect(JSON.stringify(spec.inputSchema)).toContain("matterId");
  });

  test("a matter entry already declaring matterId gets no synthetic flag", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "entities.rename",
        handlerKind: "workspace",
        inputSchema: {
          params: objectSchema({ matterId: { type: "string" } }, ["matterId"]),
        },
      }),
    );
    expect(
      spec.flags.filter((flag) => flag.flag === "--matter-id"),
    ).toHaveLength(1);
    expect(flagByCli(spec, "--matter-id")?.partPath).toBe("matterId");
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

  test("a $defs-compacted entry gets typed flags and keeps its refs in the leaf", () => {
    // The catalog carries these schemas compacted, so flag derivation has to
    // expand before it can see a property name at all. The emitted leaf keeps
    // the compacted form (the CLI expands it only to validate `--input`).
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "views.create",
        handlerKind: "root",
        inputSchema: {
          $defs: {
            s_cond: {
              type: "object",
              properties: { operator: { type: "string" } },
            },
          },
          body: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              where: { $ref: "#/$defs/s_cond" },
              having: { $ref: "#/$defs/s_cond" },
            },
          },
        },
      }),
    );
    // `--where.operator` can only exist if the ref was resolved: an unexpanded
    // `{"$ref": ...}` node carries no properties to derive a flag from.
    expect(spec.flags.map((flag) => flag.flag)).toEqual([
      "--name",
      "--where.operator",
      "--having.operator",
    ]);
    expect(spec.inputSchema["$defs"]).toEqual({
      s_cond: { type: "object", properties: { operator: { type: "string" } } },
    });
  });

  test("an entry whose $defs refs do not resolve fails the codegen", () => {
    expect(() =>
      deriveCapabilityLeaf(
        entry({
          id: "views.create",
          handlerKind: "root",
          inputSchema: { body: { $ref: "#/$defs/missing" } },
        }),
      ),
    ).toThrow(RouteGenerationError);
  });

  test("scope maps stella:* to a ToolScope, else undefined", () => {
    expect(
      deriveCapabilityLeaf(entry({ id: "a.b", scope: "stella:contacts_write" }))
        .spec.scope,
    ).toBe("contacts_write");
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

  test("maps compound catalog scopes into the capability preflight", () => {
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "templates.fill-to-matter",
        scope: "stella:documents_write",
        additionalScopes: ["stella:templates"],
      }),
    );
    expect(spec.scope).toBe("documents_write");
    expect(spec.additionalScopes).toEqual(["templates"]);
  });
});

describe("insertCapabilities: namespaced merge", () => {
  test("suppresses required-file and file-returning entries but generates the rest", () => {
    const { stats } = insertCapabilities({
      tree: { kind: "route", children: {} },
      entries: [
        entry({ id: "a.read" }),
        entry({ id: "b.upload", transport: fileInput("file", true) }),
        entry({ id: "c.export", transport: { type: "file-response" } }),
        entry({
          id: "d.fill",
          transport: {
            type: "file-both",
            input: { field: "f", required: true },
          },
        }),
        // An OPTIONAL file leaves a fileless JSON mode: generated, not
        // suppressed. This is the case the two booleans could not express.
        entry({ id: "e.prefill", transport: fileInput("file", false) }),
        // The same optionality on a `file-both` must NOT generate: the file
        // input can be omitted, but the response is still bytes the generic
        // transport cannot serialize.
        entry({
          id: "f.render",
          transport: {
            type: "file-both",
            input: { field: "f", required: false },
          },
        }),
      ],
    });
    expect(stats.generated).toBe(2);
    expect(stats.suppressed).toBe(4);
    expect(stats.suppressedIds).toEqual([
      "b.upload",
      "c.export",
      "d.fill",
      "f.render",
    ]);
  });

  test("a fileless-mode capability withholds its file field from flags and --input", () => {
    // The field is `format: "binary"`, so a generated `--file <string>` flag
    // would pass validation and reach a handler expecting a `File`. It must be
    // absent from the flags AND from the `--input` wrapper schema, and named on
    // the spec so `--help` can say why.
    const { spec } = deriveCapabilityLeaf(
      entry({
        id: "templates.prefill",
        transport: fileInput("file", false),
        inputSchema: {
          body: objectSchema({
            file: { type: "string", format: "binary" },
            text: { type: "string" },
          }),
        },
      }),
    );
    expect(spec.flags.map((flag) => flag.flag)).toEqual(["--text"]);
    expect(spec.inputOnly).toEqual([]);
    expect(spec.filelessField).toBe("file");
    expect(spec.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { body: objectSchema({ text: { type: "string" } }) },
    });
  });

  test("a curated root command and namespaced capability never compete", () => {
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
    const { tree } = insertCapabilities({
      tree: curated,
      entries: [entry({ id: "legislation.search" })],
    });
    // Curated leaf untouched.
    expect(leafAt(tree, ["legislation", "search"])).toBeUndefined();
    // Capability always lives under the `capability` group.
    expect(
      leafAt(tree, ["capability", "legislation", "search"])?.capabilityId,
    ).toBe("legislation.search");
  });

  test("a hand-wired root namespace cannot capture a capability domain", () => {
    const { tree } = insertCapabilities({
      tree: { kind: "route", children: {} },
      entries: [entry({ id: "upload.create" })],
    });

    expect(leafAt(tree, ["upload", "create"])).toBeUndefined();
    expect(leafAt(tree, ["capability", "upload", "create"])?.capabilityId).toBe(
      "upload.create",
    );
  });

  test("prefix capability ids coexist at fixed-depth action paths", () => {
    const { tree } = insertCapabilities({
      tree: { kind: "route", children: {} },
      entries: [
        entry({ id: "entities.read-summaries" }),
        entry({ id: "entities.read-summaries.count" }),
      ],
    });
    expect(
      leafAt(tree, ["capability", "entities", "read-summaries"])?.capabilityId,
    ).toBe("entities.read-summaries");
    expect(
      leafAt(tree, ["capability", "entities", "read-summaries-count"])
        ?.capabilityId,
    ).toBe("entities.read-summaries.count");
  });
});

describe("insertCapabilities: against the real curated tree + catalog", () => {
  test("merges the committed catalog with the expected shape", async () => {
    const catalogUrl = new URL("../capability-catalog.json", import.meta.url);
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
      (e) => !isTransportInvocable(e.transport),
    ).length;
    expect(stats.suppressed).toBe(suppressed);
    expect(stats.generated).toBe(catalog.length - suppressed);
  });

  test("no committed input schema carries a transport coercion union", async () => {
    // Elysia compiles `t.Integer` and friends to a string|scalar union with
    // the bounds hoisted above it. The catalog embeds the advertised
    // projection, which flattens that to the scalar; a union surviving here
    // would give the generated command an opaque `--input` where the MCP
    // surface advertises a bounded flag.
    const catalog: { id: string; inputSchema: unknown }[] = await Bun.file(
      new URL("../capability-catalog.json", import.meta.url),
    ).json();
    const coercionFormats = new Set(["integer", "numeric", "boolean"]);
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
          walk(item, `${path}[${index}]`);
        }
        return;
      }
      if (typeof node !== "object" || node === null) {
        return;
      }
      const record: Record<string, unknown> = { ...node };
      const branches = record["anyOf"];
      if (
        Array.isArray(branches) &&
        branches.some(
          (branch) =>
            typeof branch === "object" &&
            branch !== null &&
            "format" in branch &&
            typeof branch.format === "string" &&
            coercionFormats.has(branch.format) &&
            "type" in branch &&
            branch.type === "string",
        )
      ) {
        offenders.push(path);
      }
      for (const [key, value] of Object.entries(record)) {
        walk(value, `${path}.${key}`);
      }
    };
    for (const capability of catalog) {
      walk(capability.inputSchema, capability.id);
    }
    expect(offenders).toEqual([]);
  });

  test("every committed entry declares a transport", async () => {
    // `transport` is total on the wire. A snapshot entry without it would be
    // read as a plain JSON capability by anything less strict than
    // `parseCapabilityCatalog`, which is exactly the silent default this
    // field replaced.
    const catalog: { transport?: unknown }[] = await Bun.file(
      new URL("../capability-catalog.json", import.meta.url),
    ).json();
    expect(catalog.filter((e) => e.transport === undefined)).toEqual([]);
  });
});

/**
 * Ratcheted by `cli-shadowed-namespaces` in `scripts/ratchet.ts`. This stays
 * empty because the generator makes root-level capability leaves impossible.
 */
const SHADOWED_NAMESPACE_ALLOWLIST: readonly string[] = [];

describe("curated commands must not shadow capability commands", () => {
  const namespacesByKind = (node: RouteNode) => {
    const curated = new Set<string>();
    const capability = new Set<string>();
    const capabilityPaths: string[][] = [];
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
      if (current.kind === "leaf") {
        curated.add(top);
        return;
      }
      capability.add(top);
      capabilityPaths.push([...path]);
    };
    walk(node, []);
    return { capability, capabilityPaths, curated };
  };

  test("every generated capability stays at one fixed-depth namespace", async () => {
    const catalog: CapabilityCatalogEntry[] = await Bun.file(
      new URL("../capability-catalog.json", import.meta.url),
    ).json();
    const listings = await Bun.file(
      new URL("generated/registry-snapshot.json", import.meta.url),
    ).json();
    const { tree, stats } = insertCapabilities({
      entries: catalog,
      tree: generateRouteMap(listings, TOOL_ANNOTATIONS),
    });
    const { capability, capabilityPaths, curated } = namespacesByKind(tree);
    const shadowed = [...curated]
      .filter((namespace) =>
        namespace === "capability" ? false : capability.has(namespace),
      )
      .sort();

    expect([...capability]).toEqual(["capability"]);
    expect(
      capabilityPaths.every(
        (path) => path.length === 3 && path.at(0) === "capability",
      ),
    ).toBe(true);
    expect(shadowed).toEqual([...SHADOWED_NAMESPACE_ALLOWLIST].sort());
    expect(stats.generated).toBeGreaterThan(0);
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
      new URL("../capability-catalog.json", import.meta.url),
    ).json();
    const entries = parseCapabilityCatalog(raw);
    expect(entries).not.toBeNull();

    const drift: string[] = [];
    for (const catalogEntry of entries ?? []) {
      const { spec } = deriveCapabilityLeaf(catalogEntry);
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
