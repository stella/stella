// THE capability-tree generator (spec 049 Phase 3). Projects the committed
// capability-catalog snapshot into `CapabilityLeafSpec` leaves and merges them
// into the SAME `RouteNode` tree the curated 44-tool commands live in. Pure and
// deterministic: same catalog + curated tree -> byte-identical merged tree.
//
// Every non-suppressed catalog entry becomes a `stella <domain> <action>` leaf
// whose executor calls the generic `invoke_capability` tool. Entries with
// `requiresFileInput`/`returnsFileResponse` are suppressed (they can never
// succeed through the JSON generic path) but stay reachable via
// `stella capability describe` for discovery. Curated commands win every path
// collision; a colliding capability leaf drops under `stella capability
// <domain> <action>` instead.

import { RESERVED_FLAGS, RESERVED_TOP_LEVEL_NAMES } from "./annotations.js";
import {
  classifyProp,
  kebabCase,
  type PropSchema,
  RouteGenerationError,
} from "./generate-route-map.js";
import type {
  CapabilityFlagSpec,
  CapabilityLeafSpec,
  CapabilityPart,
  FlagSpec,
  JsonSchema,
  RouteNode,
  ToolScope,
} from "./route-types.js";

/** The catalog entry fields the CLI codegen consumes (a subset of the export). */
export type CapabilityCatalogEntry = {
  id: string;
  handlerKind: "workspace" | "root" | "session";
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  requiresFileInput?: boolean;
  returnsFileResponse?: boolean;
  inputSchemaTruncated?: boolean;
  inputSchema?: {
    body?: JsonSchema;
    params?: JsonSchema;
    query?: JsonSchema;
  };
};

/** Stats surfaced by the codegen log line (spec 049 deliverable 2). */
export type CapabilityTreeStats = {
  generated: number;
  /** Entries suppressed for file input/output (unreachable through generic invoke). */
  suppressed: number;
  suppressedIds: readonly string[];
  /** Capability ids relocated under `capability <domain> <action>` on a collision. */
  collisionFallbacks: readonly string[];
  /** Per-flag cross-part/reserved collisions resolved by part-prefixing. */
  flagCollisions: readonly { id: string; flag: string }[];
};

/** The three input parts, in the deterministic order flags are emitted. */
const PARTS: readonly CapabilityPart[] = ["params", "body", "query"];

/** Valid `ToolScope` strings, for mapping a catalog `stella:*` scope to a precheck. */
const TOOL_SCOPES: ReadonlySet<string> = new Set<ToolScope>([
  "read",
  "matters_write",
  "documents_write",
  "knowledge_write",
  "search",
  "onboarding",
  "templates",
  "billing_write",
  "admin_read",
  "admin_write",
  "feedback",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolScope = (value: string): value is ToolScope =>
  TOOL_SCOPES.has(value);

/** Map a catalog `stella:<scope>` to a `ToolScope` for the client precheck, else none. */
const toolScopeOf = (scope: string): ToolScope | undefined => {
  const bare = scope.startsWith("stella:") ? scope.slice("stella:".length) : "";
  return isToolScope(bare) ? bare : undefined;
};

/** The command path for a capability id: kebab every dot-separated segment. */
export const capabilityCommandPath = (id: string): readonly string[] =>
  id.split(".").map((segment) => kebabCase(segment));

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

/**
 * The input part carrying the `cursor`+`limit` pagination pair (query wins over
 * body when both somehow declare it), or `undefined` for a non-paginated
 * capability. A part paginates only when it declares BOTH props, matching the
 * `Page<T>` list contract; a lone `cursor` stays a normal (part-prefixed) flag.
 */
const paginationPartOf = (
  entry: CapabilityCatalogEntry,
): CapabilityPart | undefined => {
  for (const part of ["query", "body"] as const) {
    const props = propertyMap(entry.inputSchema?.[part]);
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
  const required = requiredSet(schema);
  const candidates: Candidate[] = [];
  for (const [prop, propSchema] of Object.entries(properties)) {
    if (skipProps.has(prop)) {
      continue;
    }
    const classification = classifyProp(prop, propSchema);
    if (classification.kind === "input-only") {
      inputOnly.push(`${part}.${prop}`);
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

type BuiltFlags = {
  flags: CapabilityFlagSpec[];
  flagCollisions: string[];
};

/**
 * Resolve candidate flags across parts into `CapabilityFlagSpec`s. A flag name
 * that is reserved, or shared by more than one candidate, is part-prefixed on
 * every offending candidate (`--query-version`), and its `prop` (the stricli
 * flag identity) is part-qualified so the identity stays unique too.
 */
const resolveFlags = (candidates: readonly Candidate[]): BuiltFlags => {
  const byBaseFlag = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byBaseFlag.get(candidate.baseFlag) ?? [];
    group.push(candidate);
    byBaseFlag.set(candidate.baseFlag, group);
  }
  const flags: CapabilityFlagSpec[] = [];
  const flagCollisions: string[] = [];
  for (const candidate of candidates) {
    const collides =
      RESERVED_FLAGS.has(candidate.baseFlag) ||
      (byBaseFlag.get(candidate.baseFlag)?.length ?? 0) > 1;
    if (collides) {
      const flag = prefixedFlag(candidate.part, candidate.partPath);
      flagCollisions.push(flag);
      flags.push({
        ...candidate.base,
        flag,
        prop: `${candidate.part}.${candidate.partPath}`,
        required: candidate.required,
        part: candidate.part,
        partPath: candidate.partPath,
      });
      continue;
    }
    flags.push({
      ...candidate.base,
      flag: candidate.baseFlag,
      prop: candidate.partPath,
      required: candidate.required,
      part: candidate.part,
      partPath: candidate.partPath,
    });
  }
  return { flags, flagCollisions };
};

/**
 * The synthesized `{ body?, params?, query? }` wrapper schema `--input` is
 * validated against. `workspaceId` is injected into `params` when the
 * capability gets a synthetic `--workspace` flag, so `--input` accepts the same
 * shape the flag produces.
 */
const buildWrapperSchema = ({
  entry,
  injectWorkspace,
}: {
  entry: CapabilityCatalogEntry;
  injectWorkspace: boolean;
}): JsonSchema => {
  const properties: Record<string, JsonSchema> = {};
  if (entry.inputSchema?.body !== undefined) {
    properties["body"] = entry.inputSchema.body;
  }
  const params = entry.inputSchema?.params;
  if (injectWorkspace) {
    const base = isRecord(params) ? params : { type: "object" };
    const baseProps = isRecord(base["properties"]) ? base["properties"] : {};
    const baseRequired: readonly unknown[] = Array.isArray(base["required"])
      ? base["required"]
      : [];
    properties["params"] = {
      ...base,
      type: "object",
      properties: { ...baseProps, workspaceId: { type: "string" } },
      required: [...baseRequired, "workspaceId"],
    };
  } else if (params !== undefined) {
    properties["params"] = params;
  }
  if (entry.inputSchema?.query !== undefined) {
    properties["query"] = entry.inputSchema.query;
  }
  return { type: "object", additionalProperties: false, properties };
};

/** Build one capability leaf from a catalog entry (spec 049 deliverable 2). */
export const deriveCapabilityLeaf = (
  entry: CapabilityCatalogEntry,
): { spec: CapabilityLeafSpec; flagCollisions: readonly string[] } => {
  const commandPath = capabilityCommandPath(entry.id);
  const scope = toolScopeOf(entry.scope);
  const paginationPart = paginationPartOf(entry);

  // Truncated entries carry no snapshot schema: no flags, no client-side
  // validation, `--input` only (the server validates against the live schema).
  if (entry.inputSchemaTruncated === true) {
    return {
      spec: {
        commandPath,
        capabilityId: entry.id,
        flags: [],
        inputOnly: [],
        paginated: paginationPart !== undefined,
        ...(paginationPart === undefined ? {} : { paginationPart }),
        ...(paginationPart === undefined ? {} : { itemsKey: "items" }),
        destructive: entry.destructive,
        ...(scope === undefined ? {} : { scope }),
        schemaTruncated: true,
      },
      flagCollisions: [],
    };
  }

  const inputOnly: string[] = [];
  const candidates: Candidate[] = [];
  const paramsProps = propertyMap(entry.inputSchema?.params);
  const injectWorkspace =
    entry.handlerKind === "workspace" && !("workspaceId" in paramsProps);
  for (const part of PARTS) {
    const skip = new Set<string>();
    if (part === paginationPart) {
      skip.add("cursor");
      skip.add("limit");
    }
    candidates.push(
      ...candidatesForPart({
        part,
        schema: entry.inputSchema?.[part],
        skipProps: skip,
        inputOnly,
      }),
    );
  }

  const { flags: resolvedFlags, flagCollisions } = resolveFlags(candidates);
  const flags: CapabilityFlagSpec[] = injectWorkspace
    ? [
        {
          flag: "--workspace",
          prop: "workspace",
          kind: "string",
          required: true,
          repeatable: false,
          part: "params",
          partPath: "workspaceId",
        },
        ...resolvedFlags,
      ]
    : resolvedFlags;

  return {
    spec: {
      commandPath,
      capabilityId: entry.id,
      flags,
      inputOnly,
      paginated: paginationPart !== undefined,
      ...(paginationPart === undefined ? {} : { paginationPart }),
      ...(paginationPart === undefined ? {} : { itemsKey: "items" }),
      destructive: entry.destructive,
      ...(scope === undefined ? {} : { scope }),
      inputSchema: buildWrapperSchema({ entry, injectWorkspace }),
      schemaTruncated: false,
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
 * Merge every non-suppressed capability into `tree` (mutated in place and
 * returned). Curated commands win: a capability whose natural path collides
 * drops under `capability <domain> <action>`; if even that collides the codegen
 * fails hard (a real ambiguity a reviewer must resolve).
 */
export const insertCapabilities = ({
  tree,
  entries,
}: {
  tree: RouteNode;
  entries: readonly CapabilityCatalogEntry[];
}): { tree: RouteNode; stats: CapabilityTreeStats } => {
  const suppressedIds: string[] = [];
  const collisionFallbacks: string[] = [];
  const flagCollisions: { id: string; flag: string }[] = [];
  let generated = 0;

  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of sorted) {
    if (
      entry.requiresFileInput === true ||
      entry.returnsFileResponse === true
    ) {
      suppressedIds.push(entry.id);
      continue;
    }
    const { spec, flagCollisions: collisions } = deriveCapabilityLeaf(entry);
    for (const flag of collisions) {
      flagCollisions.push({ id: entry.id, flag });
    }
    const natural = spec.commandPath;
    if (canInsert(tree, natural)) {
      insertAt(tree, natural, { kind: "capability-leaf", spec });
      generated += 1;
      continue;
    }
    const fallback = ["capability", ...natural];
    if (!canInsert(tree, fallback)) {
      throw new RouteGenerationError(
        `capability "${entry.id}" collides at both ${natural.join(" ")} and capability ${natural.join(" ")}`,
      );
    }
    collisionFallbacks.push(entry.id);
    insertAt(tree, fallback, {
      kind: "capability-leaf",
      spec: { ...spec, commandPath: fallback },
    });
    generated += 1;
  }

  return {
    tree,
    stats: {
      generated,
      suppressed: suppressedIds.length,
      suppressedIds,
      collisionFallbacks,
      flagCollisions,
    },
  };
};
