import { describe, expect, test } from "bun:test";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import {
  classifyProp,
  generateRouteMap,
  RouteGenerationError,
} from "./generate-route-map.js";
import type {
  FlagSpec,
  LeafCommandSpec,
  RegistryToolListing,
  RouteNode,
} from "./route-types.js";

const snapshotUrl = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);
// `Bun.file().json()` is typed `any`, so it flows into the listing type without
// a cast; the snapshot is trusted committed data.
const snapshotListings: readonly RegistryToolListing[] =
  await Bun.file(snapshotUrl).json();

const findLeaf = (
  node: RouteNode,
  path: readonly string[],
): LeafCommandSpec | undefined => {
  let current: RouteNode = node;
  for (const segment of path) {
    if (current.kind !== "route") {
      return undefined;
    }
    const next = current.children[segment];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return current.kind === "leaf" ? current.spec : undefined;
};

const leafPaths = (node: RouteNode): string[] => {
  const out: string[] = [];
  const walk = (n: RouteNode, prefix: readonly string[]): void => {
    if (n.kind === "leaf") {
      out.push(prefix.join(" "));
      return;
    }
    if (n.kind === "capability-leaf") {
      return;
    }
    for (const [name, child] of Object.entries(n.children)) {
      walk(child, [...prefix, name]);
    }
  };
  walk(node, []);
  return out.sort();
};

const leafEntries = (
  node: RouteNode,
): { path: readonly string[]; spec: LeafCommandSpec }[] => {
  const entries: { path: readonly string[]; spec: LeafCommandSpec }[] = [];
  const walk = (current: RouteNode, path: readonly string[]): void => {
    if (current.kind === "leaf") {
      entries.push({ path, spec: current.spec });
      return;
    }
    if (current.kind === "capability-leaf") {
      return;
    }
    for (const [segment, child] of Object.entries(current.children)) {
      walk(child, [...path, segment]);
    }
  };
  walk(node, []);
  return entries;
};

const flagFor = (spec: LeafCommandSpec, flag: string): FlagSpec | undefined =>
  spec.flags.find((f) => f.flag === flag);

const tree = generateRouteMap(snapshotListings, TOOL_ANNOTATIONS);

describe("generateRouteMap: structure", () => {
  test("produces 45 leaf commands and excludes the compat shims", () => {
    const paths = leafPaths(tree);
    expect(paths).toHaveLength(45);
    expect(paths).not.toContain("search");
    expect(paths).not.toContain("fetch");
    // The excluded compat tools never surface anywhere in the tree.
    expect(paths.every((p) => !p.endsWith(" fetch"))).toBe(true);
  });

  test("send_feedback maps to `feedback send` with the feedback scope", () => {
    const send = findLeaf(tree, ["feedback", "send"]);
    expect(send?.toolName).toBe("send_feedback");
    expect(send?.scope).toBe("feedback");
    expect(send?.destructive).toBe(false);
    expect(
      flagFor(send ?? errorSpec(), "--confirmation-token"),
    ).toBeUndefined();
  });

  test("destructive tools hide the boolean `confirm` gate from generated flags", () => {
    // The reserved --yes flow owns confirmation; the executor injects
    // `confirm: true`, so no redundant --confirm flag is generated.
    const del = findLeaf(tree, ["matter", "delete"]);
    expect(del?.destructive).toBe(true);
    expect(flagFor(del ?? errorSpec(), "--confirm")).toBeUndefined();
    // `confirm` still lives in the input schema (reachable via --input, and it
    // drives the executor's inject-on-confirm guard).
    const properties = del?.inputSchema["properties"];
    expect(
      typeof properties === "object" &&
        properties !== null &&
        "confirm" in properties,
    ).toBe(true);
  });

  test("command paths come from the table, not a name string-split", () => {
    expect(findLeaf(tree, ["document", "read"])?.toolName).toBe(
      "read_document",
    );
    expect(findLeaf(tree, ["document", "properties", "list"])?.toolName).toBe(
      "list_properties",
    );
    expect(findLeaf(tree, ["document", "field", "set"])?.toolName).toBe(
      "set_field_value",
    );
    expect(findLeaf(tree, ["contact", "lookup-registry"])?.toolName).toBe(
      "lookup_business_registry",
    );
    expect(findLeaf(tree, ["contact", "list"])?.toolName).toBe("list_contacts");
    // `read-document` (a mechanical split of the name) must not exist.
    expect(findLeaf(tree, ["read-document"])).toBeUndefined();
  });

  test("every curated detail reader has a discoverable list or search sibling", () => {
    const entries = leafEntries(tree);
    for (const reader of entries.filter(({ spec }) =>
      spec.toolName.startsWith("read_"),
    )) {
      const domain = reader.path.at(0);
      const hasDiscoverySibling = entries.some(
        ({ path, spec }) =>
          path.at(0) === domain &&
          (spec.toolName.startsWith("list_") ||
            spec.toolName.startsWith("search_")),
      );
      expect(hasDiscoverySibling).toBe(true);
    }
  });
});

describe("generateRouteMap: discriminator split (S2)", () => {
  const add = findLeaf(tree, ["organization", "add-member"]);
  const remove = findLeaf(tree, ["organization", "remove-member"]);
  const settings = findLeaf(tree, ["organization", "update-settings"]);

  test("manage_organization splits into three subcommands", () => {
    expect(add?.toolName).toBe("manage_organization");
    expect(remove?.toolName).toBe("manage_organization");
    expect(settings?.toolName).toBe("manage_organization");
  });

  test("the discriminator value is injected, not exposed as a flag", () => {
    expect(add?.discriminatorInject).toEqual({ action: "add_member" });
    expect(remove?.discriminatorInject).toEqual({ action: "remove_member" });
    expect(settings?.discriminatorInject).toEqual({
      action: "update_org_settings",
    });
    expect(flagFor(add ?? errorSpec(), "--action")).toBeUndefined();
  });

  test("per-subcommand flag sets and required sets match the table", () => {
    expect(add?.flags.map((f) => f.flag).sort()).toEqual([
      "--matter-id",
      "--user-id",
    ]);
    expect(add?.flags.every((f) => f.required)).toBe(true);
    expect(settings?.flags.map((f) => f.flag).sort()).toEqual([
      "--matter-number-padding",
      "--matter-number-pattern",
      "--prompt-caching-enabled",
    ]);
    expect(settings?.flags.some((f) => f.required)).toBe(false);
  });

  test("remove-member is destructive; add-member is not", () => {
    expect(remove?.destructive).toBe(true);
    expect(add?.destructive).toBe(false);
  });

  test("no manage_organization subcommand emits a --confirm flag", () => {
    // The tool's schema declares a `confirm` gate for remove_member, but the
    // reserved --yes flow owns it, so it is hidden from EVERY leaf's flags
    // (destructive or not) and reachable only via --input.
    for (const leaf of [add, remove, settings]) {
      expect(flagFor(leaf ?? errorSpec(), "--confirm")).toBeUndefined();
    }
    // It still lives in the shared input schema all three subcommands carry.
    const properties = remove?.inputSchema["properties"];
    expect(
      typeof properties === "object" &&
        properties !== null &&
        "confirm" in properties,
    ).toBe(true);
  });

  test("a required-enum that is a plain filter does NOT split", () => {
    // lookup_business_registry.registry is required + enum but a value, not a
    // discriminator: it stays one command with a --registry enum flag.
    expect(
      leafPaths(tree).filter((p) => p.startsWith("contact lookup")),
    ).toEqual(["contact lookup-registry"]);
    const lookup = findLeaf(tree, ["contact", "lookup-registry"]);
    const registry = flagFor(lookup ?? errorSpec(), "--registry");
    expect(registry?.kind).toBe("enum");
    expect(registry?.required).toBe(true);
  });
});

describe("generateRouteMap: flag mapping (S3)", () => {
  test("one-character query properties get a parser-safe long flag", () => {
    expect(classifyProp("q", { type: "string" })).toEqual({
      kind: "flag",
      spec: {
        flag: "--query",
        prop: "q",
        kind: "string",
        repeatable: false,
      },
    });
  });

  test("unknown one-character properties fail codegen", () => {
    for (const prop of "abcdefghijklmnoprstuvwxyz") {
      expect(() => classifyProp(prop, { type: "string" })).toThrow(
        RouteGenerationError,
      );
    }
  });

  test("nullable-string props map to nullable-string flags", () => {
    const save = findLeaf(tree, ["contact", "save"]);
    expect(flagFor(save ?? errorSpec(), "--first-name")?.kind).toBe(
      "nullable-string",
    );
    expect(flagFor(save ?? errorSpec(), "--type")?.kind).toBe("enum");
    // save_contact has no required[]; every flag is optional.
    expect(save?.flags.every((f) => !f.required)).toBe(true);
  });

  test("required[] props become required flags", () => {
    const del = findLeaf(tree, ["matter", "delete"]);
    expect(flagFor(del ?? errorSpec(), "--matter-id")?.required).toBe(true);
    const search = findLeaf(tree, ["search", "matters"]);
    expect(flagFor(search ?? errorSpec(), "--query")?.required).toBe(true);
  });

  test("int flags carry min/max bounds", () => {
    const search = findLeaf(tree, ["search", "matters"]);
    const limit = flagFor(search ?? errorSpec(), "--limit");
    // `limit` is a pagination flag on a paginated tool, not a value flag.
    expect(limit).toBeUndefined();
    expect(search?.paginated).toBe(true);
  });

  test("pagination props are consumed, not emitted as value flags", () => {
    const list = findLeaf(tree, ["matter", "list"]);
    expect(flagFor(list ?? errorSpec(), "--cursor")).toBeUndefined();
    expect(flagFor(list ?? errorSpec(), "--limit")).toBeUndefined();
    expect(list?.paginated).toBe(true);
  });

  test("array-of-object, free maps, and deep objects go to inputOnly", () => {
    expect(
      findLeaf(tree, ["organization", "set-jurisdictions"])?.inputOnly,
    ).toEqual(["jurisdictions"]);
    expect(findLeaf(tree, ["template", "save"])?.inputOnly).toEqual(["fields"]);
    expect(findLeaf(tree, ["template", "fill"])?.inputOnly).toEqual(["values"]);
    expect(findLeaf(tree, ["clause", "save"])?.inputOnly).toEqual([
      "body",
      "metadata",
    ]);
    // set_field_value.content has an untyped `value` child -> whole object to --input.
    expect(findLeaf(tree, ["document", "field", "set"])?.inputOnly).toEqual([
      "content",
    ]);
  });

  test("repeatable arrays of scalars would be string-array flags", () => {
    // No shipped MVP tool has a scalar array; assert the classifier via a synthetic.
    const synthetic: RegistryToolListing = {
      name: "list_matters",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      },
    };
    const node = generateRouteMap([synthetic], {
      list_matters: { command: ["matter", "list"], scope: "read" },
    });
    const leaf = findLeaf(node, ["matter", "list"]);
    const tags = flagFor(leaf ?? errorSpec(), "--tags");
    expect(tags?.kind).toBe("string-array");
    expect(tags?.repeatable).toBe(true);
  });
});

describe("generateRouteMap: collisions (S1)", () => {
  test("a generated flag colliding with a reserved global fails hard", () => {
    const bad: RegistryToolListing = {
      name: "save_matter",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { output: { type: "string" } },
      },
    };
    expect(() =>
      generateRouteMap([bad], {
        save_matter: { command: ["matter", "save"], scope: "matters_write" },
      }),
    ).toThrow(RouteGenerationError);
  });

  test("two flags normalizing to the same parser key fail hard", () => {
    const bad: RegistryToolListing = {
      name: "save_matter",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { a_b: { type: "string" }, "a.b": { type: "string" } },
      },
    };
    expect(() =>
      generateRouteMap([bad], {
        save_matter: { command: ["matter", "save"], scope: "matters_write" },
      }),
    ).toThrow(RouteGenerationError);
  });

  test("an unannotated tool whose domain hits a reserved name fails hard", () => {
    const bad: RegistryToolListing = {
      name: "help_me",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    };
    expect(() => generateRouteMap([bad], {})).toThrow(RouteGenerationError);
  });

  test("a generated tool can never shadow the hand-wired upload command", () => {
    const bad: RegistryToolListing = {
      name: "create_upload",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    };
    expect(() =>
      generateRouteMap([bad], {
        create_upload: { command: ["upload", "create"], scope: "read" },
      }),
    ).toThrow(RouteGenerationError);
  });

  test("a duplicate command path fails hard", () => {
    const one: RegistryToolListing = {
      name: "save_matter",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    };
    const two: RegistryToolListing = {
      name: "delete_matter",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    };
    expect(() =>
      generateRouteMap([one, two], {
        save_matter: { command: ["matter", "x"], scope: "read" },
        delete_matter: { command: ["matter", "x"], scope: "read" },
      }),
    ).toThrow(RouteGenerationError);
  });
});

describe("generateRouteMap: Phase 4 domains (S1/S3)", () => {
  test("list_templates is cursor-only paginated: no --limit, no cursor value flag", () => {
    const list = findLeaf(tree, ["template", "list"]);
    expect(list?.paginated).toBe(true);
    expect(flagFor(list ?? errorSpec(), "--cursor")).toBeUndefined();
    expect(flagFor(list ?? errorSpec(), "--limit")).toBeUndefined();
    // `template_id` (single-read flip) stays a normal value flag.
    expect(flagFor(list ?? errorSpec(), "--template-id")?.kind).toBe("string");
  });

  test("a fully paginated list keeps --limit as a pagination flag", () => {
    // list_clauses has both cursor and limit -> `full` pagination mode.
    const clauses = findLeaf(tree, ["clause", "list"]);
    expect(clauses?.paginated).toBe(true);
    expect(clauses?.itemsKey).toBe("clauses");
    expect(flagFor(clauses ?? errorSpec(), "--limit")).toBeUndefined();
    expect(flagFor(clauses ?? errorSpec(), "--cursor")).toBeUndefined();
  });

  test("audit-log and legislation carry the items Page envelope key", () => {
    expect(findLeaf(tree, ["audit-log", "list"])?.itemsKey).toBe("items");
    expect(findLeaf(tree, ["legislation", "search"])?.itemsKey).toBe("items");
    expect(findLeaf(tree, ["legislation", "search"])?.paginated).toBe(true);
  });

  test("feature-gated tools are present in the tree (never client-hidden)", () => {
    for (const path of [
      ["time-entry", "list"],
      ["time-entry", "save"],
      ["time-entry", "delete"],
      ["invoice", "list"],
      ["case-law", "search"],
      ["case-law", "read"],
      ["legislation", "search"],
    ]) {
      expect(findLeaf(tree, path)).toBeDefined();
    }
  });

  test("run_playbook required[] props become required flags", () => {
    const run = findLeaf(tree, ["playbook", "run"]);
    expect(flagFor(run ?? errorSpec(), "--matter-id")?.required).toBe(true);
    expect(flagFor(run ?? errorSpec(), "--playbook-id")?.required).toBe(true);
  });
});

describe("generateRouteMap: unknown fetched tools (S1 rule 5)", () => {
  test("a tool with no annotation gets a heuristic verb/domain command path", () => {
    const unknown: RegistryToolListing = {
      name: "list_widgets",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    };
    const node = generateRouteMap([unknown], {});
    const leaf = findLeaf(node, ["widgets", "list"]);
    expect(leaf?.toolName).toBe("list_widgets");
    expect(leaf?.scope).toBeUndefined();
    expect(flagFor(leaf ?? errorSpec(), "--query")?.kind).toBe("string");
  });
});

describe("generateRouteMap: parity (S6)", () => {
  test("build-time listings and a mocked tools/list body produce the same tree", () => {
    // A distinct object graph carrying the identical wire fields, as a
    // `tools/list` response would deliver them (JSON round-trip through the
    // wire). `JSON.parse` is typed `any`, so it flows in without a cast.
    const wireTools = snapshotListings.map((listing) => ({
      name: listing.name,
      description: listing.description,
      inputSchema: listing.inputSchema,
      ...(listing.annotations === undefined
        ? {}
        : { annotations: listing.annotations }),
    }));
    const mockListings: readonly RegistryToolListing[] =
      structuredClone(wireTools);

    const fromBuildTime = generateRouteMap(snapshotListings, TOOL_ANNOTATIONS);
    const fromMock = generateRouteMap(mockListings, TOOL_ANNOTATIONS);
    expect(fromMock).toEqual(fromBuildTime);
  });
});

// A never-undefined placeholder for `findLeaf` misses so assertions stay terse.
const errorSpecValue: LeafCommandSpec = {
  commandPath: [],
  toolName: "__missing__",
  flags: [],
  inputOnly: [],
  paginated: false,
  windowedText: false,
  destructive: false,
  inputSchema: {},
};
function errorSpec(): LeafCommandSpec {
  return errorSpecValue;
}
