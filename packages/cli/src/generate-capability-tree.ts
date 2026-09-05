// THE capability-tree generator (spec 049 Phase 3). Projects the committed
// capability-catalog snapshot into `CapabilityLeafSpec` leaves and merges them
// into the SAME `RouteNode` tree the curated 44-tool commands live in. Pure and
// deterministic: same catalog + curated tree -> byte-identical merged tree.
//
// Every non-suppressed catalog entry becomes a
// `stella capability <domain> <action>` leaf
// whose executor calls the generic `invoke_capability` tool. Suppression is
// decided by the entry's `transport` disposition, not by a pair of booleans: a
// file response or a REQUIRED file input can never succeed over the JSON generic
// path, while an OPTIONAL file input leaves a fileless mode that is generated
// with the file field withheld. Suppressed entries stay reachable via
// `stella capability describe` for discovery. Keeping every generic capability
// below one namespace makes it impossible for a future catalog domain to
// recreate a parallel root command group beside the curated CLI.

import { panic } from "better-result";

import { RESERVED_FLAGS, RESERVED_TOP_LEVEL_NAMES } from "./annotations.js";
import { DEFS_KEY, expandSchemaDefs } from "./expand-schema-defs.js";
import { flagKey } from "./flag-name.js";
import {
  classifyProp,
  generateRouteMap,
  kebabCase,
  type PropSchema,
  RouteGenerationError,
} from "./generate-route-map.js";
import { MCP_CLI_TOOL_SCOPES } from "./generated/mcp-contract.js";
import {
  CAPABILITY_PARTS,
  type CapabilityFlagSpec,
  type CapabilityLeafSpec,
  type CapabilityPart,
  type FlagSpec,
  type JsonSchema,
  type RegistryToolListing,
  type RouteNode,
  type ToolAnnotation,
  type ToolScope,
} from "./route-types.js";

/**
 * The catalog's transport disposition, mirrored here because `@stll/cli` never
 * imports `apps/api`. The API-side definition
 * (`apps/api/src/lib/capability-transport.ts`) is the source of truth; this copy
 * cannot drift silently because the exporter validates its generated catalog
 * through `parseCapabilityCatalog` (below) and then asserts, in both directions,
 * that the leaves `insertCapabilities` emits are exactly the entries the
 * API-side predicate calls invocable.
 */
export type CapabilityTransport =
  | { type: "json" }
  | { type: "file-input"; input: { field: string; required: boolean } }
  | { type: "file-response" }
  | { type: "file-both"; input: { field: string; required: boolean } };

/** The catalog entry fields the CLI codegen consumes (a subset of the export). */
export type CapabilityCatalogEntry = {
  id: string;
  /** Authored prose from the handler config; the command's `--help` brief. */
  description?: string;
  handlerKind: "workspace" | "root" | "session";
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  additionalScopes?: readonly string[];
  transport: CapabilityTransport;
  /**
   * The handler's input schema as the catalog carries it: `$defs`-compacted.
   * Flag derivation works on the expanded form; the emitted leaf keeps the
   * compacted one (see `deriveCapabilityLeaf`).
   */
  inputSchema: {
    $defs?: JsonSchema;
    body?: JsonSchema;
    params?: JsonSchema;
    query?: JsonSchema;
  };
};

/** A capability's input schema with every `$defs` ref inlined. */
type ExpandedInputSchema = {
  body?: JsonSchema;
  params?: JsonSchema;
  query?: JsonSchema;
};

/**
 * Whether the generic JSON transport can run this capability at all. Mirrors
 * `isTransportInvocable` in `apps/api/src/lib/capability-transport.ts`; the
 * exporter fails if the two ever disagree.
 */
export const isTransportInvocable = (
  transport: CapabilityTransport,
): boolean => {
  switch (transport.type) {
    case "json":
      return true;
    case "file-input":
      return !transport.input.required;
    case "file-response":
    case "file-both":
      return false;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/**
 * The file field a JSON caller must omit on an invocable capability, or
 * `undefined` when there is none. Withheld from the generated flags and from the
 * `--input` wrapper schema: a `format: "binary"` prop would otherwise become a
 * plain `--file <string>` flag that passes validation and reaches a handler
 * expecting a `File`.
 */
const filelessOnlyField = (
  transport: CapabilityTransport,
): string | undefined => {
  if (transport.type !== "file-input" || transport.input.required) {
    return undefined;
  }
  return transport.input.field;
};

/** Stats surfaced by the codegen log line (spec 049 deliverable 2). */
export type CapabilityTreeStats = {
  generated: number;
  /** Entries whose transport suppresses them (unreachable through generic invoke). */
  suppressed: number;
  suppressedIds: readonly string[];
  /** Per-flag cross-part/reserved collisions resolved by part-prefixing. */
  flagCollisions: readonly { id: string; flag: string }[];
};

/** The single root beneath which all generated capability commands live. */
export const CAPABILITY_NAMESPACE = "capability";

export type CapabilityCommandPath = readonly [
  typeof CAPABILITY_NAMESPACE,
  string,
  string,
];

export type FormattedCapabilityCommand =
  `stella ${typeof CAPABILITY_NAMESPACE} ${string} ${string}`;

/** Valid `ToolScope` strings, for mapping a catalog `stella:*` scope to a precheck. */
const TOOL_SCOPES: ReadonlySet<string> = new Set(MCP_CLI_TOOL_SCOPES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolScope = (value: string): value is ToolScope =>
  TOOL_SCOPES.has(value);

/** Map a catalog `stella:<scope>` to a `ToolScope` for the client precheck, else none. */
const toolScopeOf = (scope: string): ToolScope | undefined => {
  const bare = scope.startsWith("stella:") ? scope.slice("stella:".length) : "";
  return isToolScope(bare) ? bare : undefined;
};

/**
 * The namespaced command path for a capability id. The domain stays grouped,
 * while every remaining id segment is flattened into one action. Fixed-depth
 * paths make prefix ids (for example `entities.read` and
 * `entities.read.count`) representable without a leaf/route collision.
 */
export const capabilityCommandPath = (id: string): CapabilityCommandPath => {
  const [rawDomain, ...rawAction] = id.split(".");
  if (
    rawDomain === undefined ||
    rawDomain.length === 0 ||
    rawAction.length === 0 ||
    rawAction.some((segment) => segment.length === 0)
  ) {
    throw new RouteGenerationError(
      `capability "${id}" must contain a domain and action`,
    );
  }
  return [
    CAPABILITY_NAMESPACE,
    kebabCase(rawDomain),
    rawAction.map((segment) => kebabCase(segment)).join("-"),
  ];
};

/** Render the exact executable command prefix for one capability id. */
export const formatCapabilityCommand = (
  id: string,
): FormattedCapabilityCommand => {
  const [namespace, domain, action] = capabilityCommandPath(id);
  return `stella ${namespace} ${domain} ${action}`;
};

const propertyMap = (
  schema: JsonSchema | undefined,
): Record<string, PropSchema> => {
  if (schema === undefined) {
    return {};
  }
  const raw = schema["properties"];
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, PropSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      out[key] = value;
    }
  }
  return out;
};

const requiredSet = (schema: JsonSchema | undefined): ReadonlySet<string> => {
  const raw = schema?.["required"];
  if (!Array.isArray(raw)) {
    return new Set();
  }
  return new Set(raw.filter((r): r is string => typeof r === "string"));
};

const hasDynamicObjectKeys = (schema: JsonSchema): boolean =>
  schema["additionalProperties"] === true ||
  isRecord(schema["additionalProperties"]) ||
  isRecord(schema["patternProperties"]);

const hasSchemaAlternatives = (schema: JsonSchema): boolean =>
  Array.isArray(schema["anyOf"]) || Array.isArray(schema["oneOf"]);

const requiresWholePartInput = (schema: JsonSchema): boolean => {
  if (hasSchemaAlternatives(schema) || hasDynamicObjectKeys(schema)) {
    return true;
  }
  const intersections = schema["allOf"];
  return (
    Array.isArray(intersections) &&
    intersections.some(
      (intersection) =>
        isRecord(intersection) && requiresWholePartInput(intersection),
    )
  );
};

/**
 * The input part carrying the `cursor`+`limit` pagination pair (query wins over
 * body when both somehow declare it), or `undefined` for a non-paginated
 * capability. A part paginates only when it declares BOTH props, matching the
 * `Page<T>` list contract; a lone `cursor` stays a normal (part-prefixed) flag.
 */
const paginationPartOf = (
  inputSchema: ExpandedInputSchema,
): CapabilityPart | undefined => {
  for (const part of ["query", "body"] as const) {
    const props = propertyMap(inputSchema[part]);
    if ("cursor" in props && "limit" in props) {
      return part;
    }
  }
  return undefined;
};

type Candidate = {
  part: CapabilityPart;
  /** Property path within the part (leaf name, or dotted for a depth-2 object). */
  partPath: string;
  /** Bare flag name from `classifyProp` (`--foo`), before collision prefixing. */
  baseFlag: string;
  base: Omit<FlagSpec, "required" | "flag" | "prop">;
  required: boolean;
};

/** Classify one part's props into flag candidates + input-only paths. */
const candidatesForPart = ({
  part,
  schema,
  skipProps,
  inputOnly,
}: {
  part: CapabilityPart;
  schema: JsonSchema | undefined;
  skipProps: ReadonlySet<string>;
  inputOnly: string[];
}): Candidate[] => {
  const properties = propertyMap(schema);
  const wholePartInputOnly =
    schema !== undefined && requiresWholePartInput(schema);
  if (wholePartInputOnly) {
    inputOnly.push(part);
  }
  const required = requiredSet(schema);
  const candidates: Candidate[] = [];
  for (const [prop, propSchema] of Object.entries(properties)) {
    if (skipProps.has(prop)) {
      continue;
    }
    const classification = classifyProp(prop, propSchema);
    if (classification.kind === "input-only") {
      if (!wholePartInputOnly) {
        inputOnly.push(`${part}.${prop}`);
      }
      continue;
    }
    const specs =
      classification.kind === "flag"
        ? [classification.spec]
        : classification.children;
    for (const spec of specs) {
      const { flag, prop: partPath, ...base } = spec;
      candidates.push({
        part,
        partPath,
        baseFlag: flag,
        base,
        required: classification.kind === "flag" ? required.has(prop) : false,
      });
    }
  }
  return candidates;
};

/** Part-prefixed flag name for a collision: `--query-parent-child`. */
const prefixedFlag = (part: CapabilityPart, partPath: string): string =>
  `--${[part, ...partPath.split(".")].map((segment) => kebabCase(segment)).join("-")}`;

const parserKeyForFlag = (flag: string): string => flagKey({ flag });

type BuiltFlags = {
  flags: CapabilityFlagSpec[];
  flagCollisions: string[];
};

/**
 * Resolve candidate flags across parts into `CapabilityFlagSpec`s. A flag name
 * that is reserved, taken (the synthetic `--matter-id`), or shared by more than
 * one candidate is part-prefixed on every offending candidate
 * (`--query-version`), and its `prop` (the stricli flag identity) is
 * part-qualified so the identity stays unique too. Uniqueness is then enforced
 * GLOBALLY over the final names: a prefixed flag colliding with another
 * candidate's natural name (e.g. `query.version` -> `--query-version` vs
 * `body.queryVersion` -> `--query-version`) prefixes that candidate too, and an
 * irresolvable duplicate fails generation with the capability id and flag, so
 * an ambiguous flag surface can never ship.
 */
const resolveFlags = ({
  capabilityId,
  candidates,
  takenNames,
}: {
  capabilityId: string;
  candidates: readonly Candidate[];
  /** Names owned outside the candidates (the synthetic `--matter-id`). */
  takenNames: ReadonlySet<string>;
}): BuiltFlags => {
  const reservedParserKeys = new Set([...RESERVED_FLAGS].map(parserKeyForFlag));
  const takenParserKeys = new Set([...takenNames].map(parserKeyForFlag));
  const byBaseParserKey = new Map<string, number>();
  for (const candidate of candidates) {
    const parserKey = parserKeyForFlag(candidate.baseFlag);
    byBaseParserKey.set(parserKey, (byBaseParserKey.get(parserKey) ?? 0) + 1);
  }
  const resolved = candidates.map((candidate) => ({
    candidate,
    prefixed:
      reservedParserKeys.has(parserKeyForFlag(candidate.baseFlag)) ||
      takenParserKeys.has(parserKeyForFlag(candidate.baseFlag)) ||
      (byBaseParserKey.get(parserKeyForFlag(candidate.baseFlag)) ?? 0) > 1,
  }));
  const finalName = (entry: (typeof resolved)[number]): string =>
    entry.prefixed
      ? prefixedFlag(entry.candidate.part, entry.candidate.partPath)
      : entry.candidate.baseFlag;

  // Global-uniqueness fixpoint: group by Stricli's parsed identity rather than
  // public spelling. For example, `--user.id` and `--user-id` both parse as
  // `userId` under allow-kebab-for-camel. Any duplicate identity (or identity
  // owned outside the candidates) prefixes all unprefixed members. Prefixing
  // only flips false -> true, so the loop terminates.
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, (typeof resolved)[number][]>();
    for (const entry of resolved) {
      const parserKey = parserKeyForFlag(finalName(entry));
      const group = groups.get(parserKey) ?? [];
      group.push(entry);
      groups.set(parserKey, group);
    }
    for (const [parserKey, group] of groups) {
      if (group.length <= 1 && !takenParserKeys.has(parserKey)) {
        continue;
      }
      for (const entry of group) {
        if (!entry.prefixed) {
          entry.prefixed = true;
          changed = true;
        }
      }
    }
  }

  const seenParserKeys = new Map<string, string>();
  const flags: CapabilityFlagSpec[] = [];
  const flagCollisions: string[] = [];
  for (const entry of resolved) {
    const { candidate } = entry;
    const flag = finalName(entry);
    const source = `${candidate.part}.${candidate.partPath}`;
    const parserKey = parserKeyForFlag(flag);
    const existing = seenParserKeys.get(parserKey);
    if (existing !== undefined || takenParserKeys.has(parserKey)) {
      throw new RouteGenerationError(
        `capability "${capabilityId}": flag ${flag} (from ${source}) collides at parser key ${parserKey} with ${existing ?? "a reserved leaf flag"} even after part-prefixing`,
      );
    }
    seenParserKeys.set(parserKey, source);
    if (entry.prefixed) {
      flagCollisions.push(flag);
    }
    flags.push({
      ...candidate.base,
      flag,
      prop: entry.prefixed ? source : candidate.partPath,
      required: candidate.required,
      part: candidate.part,
      partPath: candidate.partPath,
    });
  }
  return { flags, flagCollisions };
};

/**
 * The body schema with the fileless-mode file property removed. The property is
 * optional by construction (that is what makes the capability invocable), so
 * dropping it leaves a schema the server still accepts, and `--input` can no
 * longer advertise a field the JSON transport cannot carry.
 */
const withoutFilelessField = (body: JsonSchema, field: string): JsonSchema => {
  const properties = body["properties"];
  if (!isRecord(properties) || !(field in properties)) {
    return body;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key !== field) {
      kept[key] = value;
    }
  }
  return { ...body, properties: kept };
};

/**
 * The synthesized `{ body?, params?, query? }` wrapper schema `--input` is
 * validated against. `matterId` is injected into `params` when the capability
 * gets a synthetic `--matter-id` flag, so `--input` accepts the same shape the
 * flag produces.
 *
 * `body` and `query` stay in their `$defs`-compacted form and the entry's
 * `$defs` block rides along at the wrapper root, which is what `#/$defs/...`
 * already points at. Baking the expanded schemas instead would put the same
 * recursive condition subschema into the generated route map a dozen times per
 * capability, for no gain: `--input` validation expands on demand. `params` is
 * taken expanded, because injecting `matterId` has to merge into its
 * properties, which a ref node does not carry.
 */
const buildWrapperSchema = ({
  compacted,
  expanded,
  filelessField,
  injectMatter,
}: {
  compacted: CapabilityCatalogEntry["inputSchema"];
  expanded: ExpandedInputSchema;
  filelessField: string | undefined;
  injectMatter: boolean;
}): JsonSchema => {
  const properties: Record<string, JsonSchema> = {};
  if (compacted.body !== undefined) {
    // The withheld file field is dropped from the compacted body directly: a
    // ref can only stand where a schema stood, so removing a property leaves
    // the surrounding `$defs` references intact.
    properties["body"] =
      filelessField === undefined
        ? compacted.body
        : withoutFilelessField(compacted.body, filelessField);
  }
  const params = injectMatter ? expanded.params : compacted.params;
  if (injectMatter) {
    const base = isRecord(params) ? params : { type: "object" };
    const baseProps = isRecord(base["properties"]) ? base["properties"] : {};
    const baseRequired: readonly unknown[] = Array.isArray(base["required"])
      ? base["required"]
      : [];
    properties["params"] = {
      ...base,
      type: "object",
      properties: { ...baseProps, matterId: { type: "string" } },
      required: [...baseRequired, "matterId"],
    };
  } else if (params !== undefined) {
    properties["params"] = params;
  }
  if (compacted.query !== undefined) {
    properties["query"] = compacted.query;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(compacted.$defs === undefined ? {} : { [DEFS_KEY]: compacted.$defs }),
  };
};

/** Build one capability leaf from a catalog entry (spec 049 deliverable 2). */
export const deriveCapabilityLeaf = (
  entry: CapabilityCatalogEntry,
): { spec: CapabilityLeafSpec; flagCollisions: readonly string[] } => {
  const commandPath = capabilityCommandPath(entry.id);
  const scope = toolScopeOf(entry.scope);
  const additionalScopes = entry.additionalScopes?.flatMap((candidate) => {
    const mapped = toolScopeOf(candidate);
    return mapped === undefined ? [] : [mapped];
  });
  // Flags, pagination, and the matter injection all read PROPERTY NAMES, so
  // they need the schema with its `$defs` refs inlined. A catalog whose refs do
  // not resolve is a corrupt artifact, not a schema to guess at.
  const expanded = expandSchemaDefs(entry.inputSchema);
  if (expanded === null) {
    throw new RouteGenerationError(
      `capability "${entry.id}": input schema has $defs references that do not resolve`,
    );
  }
  const expandedInputSchema: ExpandedInputSchema = expanded;
  const paginationPart = paginationPartOf(expandedInputSchema);

  const inputOnly: string[] = [];
  const candidates: Candidate[] = [];
  const paramsProps = propertyMap(expandedInputSchema.params);
  const injectMatter =
    entry.handlerKind === "workspace" && !("matterId" in paramsProps);
  const filelessField = filelessOnlyField(entry.transport);
  for (const part of CAPABILITY_PARTS) {
    const skip = new Set<string>();
    if (part === paginationPart) {
      skip.add("cursor");
      skip.add("limit");
    }
    // The fileless-mode file field is withheld entirely: it is neither a flag
    // nor reachable through `--input`, because no JSON value can stand in for
    // the bytes.
    if (part === "body" && filelessField !== undefined) {
      skip.add(filelessField);
    }
    candidates.push(
      ...candidatesForPart({
        part,
        schema: expandedInputSchema[part],
        skipProps: skip,
        inputOnly,
      }),
    );
  }

  const { flags: resolvedFlags, flagCollisions } = resolveFlags({
    capabilityId: entry.id,
    candidates,
    takenNames: injectMatter ? new Set(["--matter-id"]) : new Set(),
  });
  const flags: CapabilityFlagSpec[] = injectMatter
    ? [
        // Named like the flag a capability declaring params.matterId itself
        // derives, so every matter-scoped command takes the same --matter-id
        // whichever way its schema arrived.
        {
          flag: "--matter-id",
          prop: "matterId",
          kind: "string",
          required: true,
          repeatable: false,
          part: "params",
          partPath: "matterId",
        },
        ...resolvedFlags,
      ]
    : resolvedFlags;

  return {
    spec: {
      commandPath,
      capabilityId: entry.id,
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
      access: entry.access,
      flags,
      inputOnly,
      paginated: paginationPart !== undefined,
      ...(paginationPart === undefined ? {} : { paginationPart }),
      ...(paginationPart === undefined ? {} : { itemsKey: "items" }),
      destructive: entry.destructive,
      ...(scope === undefined ? {} : { scope }),
      ...(additionalScopes === undefined || additionalScopes.length === 0
        ? {}
        : { additionalScopes }),
      inputSchema: buildWrapperSchema({
        compacted: entry.inputSchema,
        expanded: expandedInputSchema,
        filelessField,
        injectMatter,
      }),
      ...(filelessField === undefined ? {} : { filelessField }),
    },
    flagCollisions,
  };
};

/**
 * Whether `path` can be inserted into `tree` without disturbing an existing
 * (curated or already-inserted) command: no intermediate segment may pass
 * through a leaf, the terminal must be free, and the top-level segment must not
 * be a reserved name.
 */
const canInsert = (tree: RouteNode, path: readonly string[]): boolean => {
  const top = path[0];
  if (top === undefined || RESERVED_TOP_LEVEL_NAMES.has(top)) {
    return false;
  }
  let node: RouteNode = tree;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (node.kind !== "route") {
      return false;
    }
    const segment = path[index];
    if (segment === undefined) {
      return false;
    }
    const child = node.children[segment];
    if (child === undefined) {
      return true; // rest of the path is fresh
    }
    if (child.kind !== "route") {
      return false; // would pass through an existing leaf
    }
    node = child;
  }
  const terminal = path.at(-1);
  return (
    node.kind === "route" &&
    terminal !== undefined &&
    node.children[terminal] === undefined
  );
};

/** Insert a leaf node at `path`, creating intermediate route nodes. */
const insertAt = (
  tree: RouteNode,
  path: readonly string[],
  leaf: RouteNode,
): void => {
  let node: RouteNode = tree;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (node.kind !== "route") {
      throw new RouteGenerationError("capability insert passed through a leaf");
    }
    const segment = path[index] ?? "";
    const child = node.children[segment];
    if (child === undefined) {
      const created: RouteNode = { kind: "route", children: {} };
      node.children[segment] = created;
      node = created;
      continue;
    }
    node = child;
  }
  const terminal = path.at(-1);
  if (node.kind !== "route" || terminal === undefined) {
    throw new RouteGenerationError("capability insert has no terminal segment");
  }
  node.children[terminal] = leaf;
};

/**
 * Merge every non-suppressed capability into the dedicated `capability`
 * namespace (mutating and returning `tree`). Any collision fails generation;
 * generic capability leaves can never leak back into a root domain.
 */
export const insertCapabilities = ({
  tree,
  entries,
}: {
  tree: RouteNode;
  entries: readonly CapabilityCatalogEntry[];
}): { tree: RouteNode; stats: CapabilityTreeStats } => {
  const suppressedIds: string[] = [];
  const flagCollisions: { id: string; flag: string }[] = [];
  let generated = 0;

  const sorted = entries.toSorted((a, b) => a.id.localeCompare(b.id));
  for (const entry of sorted) {
    if (!isTransportInvocable(entry.transport)) {
      suppressedIds.push(entry.id);
      continue;
    }
    const { spec, flagCollisions: collisions } = deriveCapabilityLeaf(entry);
    for (const flag of collisions) {
      flagCollisions.push({ id: entry.id, flag });
    }
    if (!canInsert(tree, spec.commandPath)) {
      throw new RouteGenerationError(
        `capability "${entry.id}" collides at ${spec.commandPath.join(" ")}`,
      );
    }
    insertAt(tree, spec.commandPath, { kind: "capability-leaf", spec });
    generated += 1;
  }

  return {
    tree,
    stats: {
      generated,
      suppressed: suppressedIds.length,
      suppressedIds,
      flagCollisions,
    },
  };
};

/**
 * The sorted, deduped domain segments actually present under the merged
 * tree's `capability` namespace. Route-kind children only: `capability
 * list`/`describe`/`invoke` are curated leaves living beside the domains
 * (from their own tool annotations), not domains themselves. The skill
 * documents this list so an agent choosing `stella capability <domain>
 * <action>` never has to guess a domain name.
 */
export const capabilityDomainsOf = (tree: RouteNode): readonly string[] => {
  if (tree.kind !== "route") {
    return [];
  }
  const namespace = tree.children[CAPABILITY_NAMESPACE];
  if (namespace?.kind !== "route") {
    return [];
  }
  return Object.entries(namespace.children)
    .filter(([, node]) => node.kind === "route")
    .map(([domain]) => domain)
    .toSorted((a, b) => a.localeCompare(b, "en"));
};

/**
 * THE full-tree builder: curated route map + capability merge, in one shared
 * function so build-time codegen and the runtime registry-refresh path (a
 * cached `tools/list` with a non-empty delta) produce structurally identical
 * trees; the capability leaves can never silently vanish from one of them.
 */
export const buildCliRouteTree = ({
  listings,
  annotations,
  entries,
}: {
  listings: readonly RegistryToolListing[];
  annotations: Readonly<Record<string, ToolAnnotation>>;
  entries: readonly CapabilityCatalogEntry[];
}): { tree: RouteNode; stats: CapabilityTreeStats } =>
  insertCapabilities({
    tree: generateRouteMap(listings, annotations),
    entries,
  });
