// Assembles a stricli `RoutingTarget` tree from a generated `RouteNode` (spec
// 051 S5.1). Each leaf becomes a `buildCommand` whose `func` delegates to the
// generic `runLeafCommand` executor; each route node becomes a `buildRouteMap`.
// stricli's own flag parsing is kept deliberately permissive (every value flag
// is an optional parsed string, booleans are optional): all validation and
// exit-code selection happen inside the executor, so `process.exitCode` is set
// precisely rather than defaulted by stricli.

import { buildCommand, buildRouteMap } from "@stricli/core";
import type {
  BaseFlags,
  Command,
  CommandBuilderArguments,
  RouteMap,
} from "@stricli/core";

import type { Context } from "./context.js";
import type { ResourceLeafSpec, ResourceNode } from "./resource-types.js";
import type {
  CapabilityLeafSpec,
  FlagSpec,
  LeafCommandSpec,
  RouteNode,
} from "./route-types.js";
import { runCapabilityCommand } from "./run-capability-command.js";
import {
  flagKey,
  RESERVED_FLAG_KEYS,
  runLeafCommand,
} from "./run-leaf-command.js";
import { runResourceCommand } from "./run-resource-command.js";

/** A stricli routing target: a leaf command or a nested route map. */
type RoutingTarget = Command<Context> | RouteMap<Context>;

const identity = (value: string): string => value;

const parsedStringFlag = (brief: string) =>
  ({ brief, kind: "parsed", optional: true, parse: identity }) as const;

const variadicFlag = (brief: string) =>
  ({ brief, kind: "parsed", variadic: true, parse: identity }) as const;

const booleanFlag = (brief: string, withNegated: boolean) =>
  ({ brief, kind: "boolean", optional: true, withNegated }) as const;

/**
 * A flag's `--help` line: the property's authored prose first (that is what a
 * caller — usually an agent — actually needs), then the mechanical
 * required/kind/enum/range facts the schema already encodes.
 */
const flagBrief = (spec: FlagSpec): string => {
  const facts = mechanicalFlagFacts(spec);
  return spec.description === undefined
    ? facts
    : `${spec.description} [${facts}]`;
};

const mechanicalFlagFacts = (spec: FlagSpec): string => {
  const parts = [spec.required ? "(required)" : "(optional)", spec.kind];
  if (spec.enum) {
    parts.push(`one of: ${spec.enum.join(", ")}`);
  }
  if (spec.min !== undefined || spec.max !== undefined) {
    parts.push(`range ${spec.min ?? "-inf"}..${spec.max ?? "inf"}`);
  }
  if (spec.repeatable) {
    parts.push("repeatable");
  }
  return parts.join(" ");
};

const hasLimitProp = (spec: LeafCommandSpec): boolean => {
  const properties = spec.inputSchema["properties"];
  if (typeof properties !== "object" || properties === null) {
    return false;
  }
  return "limit" in properties;
};

const buildLeafFlags = (spec: LeafCommandSpec): Record<string, unknown> => {
  const flags: Record<string, unknown> = {};

  for (const flagSpec of spec.flags) {
    const key = flagKey(flagSpec);
    const brief = flagBrief(flagSpec);
    if (flagSpec.kind === "boolean") {
      flags[key] = booleanFlag(brief, true);
      continue;
    }
    if (flagSpec.repeatable) {
      flags[key] = variadicFlag(brief);
      continue;
    }
    flags[key] = parsedStringFlag(brief);
  }

  // Reserved global flags every command carries (spec S1/S3).
  flags[RESERVED_FLAG_KEYS.input] = parsedStringFlag(
    "Full tool-args JSON: '<json>' | - (stdin) | @file",
  );
  flags[RESERVED_FLAG_KEYS.output] = parsedStringFlag(
    "Output format: json | table | jsonl",
  );
  flags[RESERVED_FLAG_KEYS.json] = booleanFlag(
    "Output JSON (= --output json)",
    false,
  );
  flags[RESERVED_FLAG_KEYS.table] = booleanFlag(
    "Output a table (= --output table)",
    false,
  );
  flags[RESERVED_FLAG_KEYS.noInput] = booleanFlag(
    "Never prompt; fail closed (exit 7) where a confirmation is required",
    false,
  );

  if (spec.paginated) {
    flags[RESERVED_FLAG_KEYS.cursor] = parsedStringFlag(
      "Opaque pagination cursor from a previous page",
    );
    flags[RESERVED_FLAG_KEYS.all] = booleanFlag(
      "Follow cursors and return every page (bounded)",
      false,
    );
    if (hasLimitProp(spec)) {
      flags[RESERVED_FLAG_KEYS.limit] = parsedStringFlag("Max items per page");
    }
  }

  // A destructive leaf gets --yes for its upfront prompt; a confirm-passthrough
  // leaf (per-target destructiveness, e.g. `capability invoke`) gets it so the
  // caller can pre-approve the server's confirmation_required gate.
  if (spec.destructive || spec.confirmPassthrough === true) {
    flags[RESERVED_FLAG_KEYS.yes] = booleanFlag(
      "Skip the destructive-op confirmation prompt",
      false,
    );
  }

  return flags;
};

const leafBrief = (spec: LeafCommandSpec): string => {
  const inputHint =
    spec.inputOnly.length > 0
      ? ` (via --input only: ${spec.inputOnly.join(", ")})`
      : "";
  return `Run the ${spec.toolName} tool${inputHint}`;
};

const buildLeafCommand = (spec: LeafCommandSpec): RoutingTarget => {
  const flags = buildLeafFlags(spec);
  const builderArgs = {
    docs: { brief: leafBrief(spec) },
    parameters: { flags },
    func: async function func(
      this: Context,
      parsedFlags: Record<string, unknown>,
    ): Promise<void> {
      await runLeafCommand({ context: this, flags: parsedFlags, spec });
    },
  };
  // SAFETY: flags is assembled from FlagSpecs at build time, so the concrete
  // FLAGS generic cannot be spelled out; every entry is a valid stricli flag
  // parameter and the executor reads flags by name.
  const typedArgs: CommandBuilderArguments<BaseFlags, [], Context> =
    // eslint-disable-next-line no-unsafe-type-assertion -- see SAFETY comment above
    builderArgs as unknown as CommandBuilderArguments<BaseFlags, [], Context>;
  return buildCommand(typedArgs);
};

const capabilityInputHint = (spec: CapabilityLeafSpec): string => {
  if (spec.inputOnly.length > 0) {
    return ` (via --input only: ${spec.inputOnly.join(", ")})`;
  }
  if (spec.schemaTruncated) {
    return " (--input only)";
  }
  return "";
};

/**
 * The command's `--help` brief. The catalog's authored description is the whole
 * point of the single-registry design, so it wins outright; the id-derived line
 * survives only as the fallback for a capability that has not been given a
 * description yet (a shrinking set — see the description-coverage ratchet).
 */
const capabilityLeafBrief = (spec: CapabilityLeafSpec): string => {
  const hint = capabilityInputHint(spec);
  if (spec.description === undefined) {
    return `Invoke the ${spec.capabilityId} capability${hint}`;
  }
  return `${spec.description}${hint}`;
};

const buildCapabilityLeafFlags = (
  spec: CapabilityLeafSpec,
): Record<string, unknown> => {
  const flags: Record<string, unknown> = {};

  for (const flagSpec of spec.flags) {
    const key = flagKey(flagSpec);
    const brief = flagBrief(flagSpec);
    if (flagSpec.kind === "boolean") {
      flags[key] = booleanFlag(brief, true);
      continue;
    }
    if (flagSpec.repeatable) {
      flags[key] = variadicFlag(brief);
      continue;
    }
    flags[key] = parsedStringFlag(brief);
  }

  flags[RESERVED_FLAG_KEYS.input] = parsedStringFlag(
    "Full capability input JSON ({ body?, params?, query? }): '<json>' | - (stdin) | @file",
  );
  flags[RESERVED_FLAG_KEYS.output] = parsedStringFlag(
    "Output format: json | table | jsonl",
  );
  flags[RESERVED_FLAG_KEYS.json] = booleanFlag(
    "Output JSON (= --output json)",
    false,
  );
  flags[RESERVED_FLAG_KEYS.table] = booleanFlag(
    "Output a table (= --output table)",
    false,
  );
  flags[RESERVED_FLAG_KEYS.noInput] = booleanFlag(
    "Never prompt; fail closed (exit 7) where a confirmation is required",
    false,
  );
  flags[RESERVED_FLAG_KEYS.dryRun] = booleanFlag(
    "Validate the input server-side and return without executing (validateOnly)",
    false,
  );

  if (spec.paginated) {
    flags[RESERVED_FLAG_KEYS.cursor] = parsedStringFlag(
      "Opaque pagination cursor from a previous page",
    );
    flags[RESERVED_FLAG_KEYS.limit] = parsedStringFlag("Max items per page");
    flags[RESERVED_FLAG_KEYS.all] = booleanFlag(
      "Follow cursors and return every page (bounded)",
      false,
    );
  }

  // Every capability leaf carries the server's per-capability confirm gate, so
  // it always accepts --yes (pre-approve) alongside the TTY prompt/retry flow.
  flags[RESERVED_FLAG_KEYS.yes] = booleanFlag(
    "Skip the destructive-op confirmation prompt",
    false,
  );

  return flags;
};

const buildCapabilityLeafCommand = (
  spec: CapabilityLeafSpec,
): RoutingTarget => {
  const flags = buildCapabilityLeafFlags(spec);
  const builderArgs = {
    docs: { brief: capabilityLeafBrief(spec) },
    parameters: { flags },
    func: async function func(
      this: Context,
      parsedFlags: Record<string, unknown>,
    ): Promise<void> {
      await runCapabilityCommand({ context: this, flags: parsedFlags, spec });
    },
  };
  const typedArgs: CommandBuilderArguments<BaseFlags, [], Context> =
    // eslint-disable-next-line no-unsafe-type-assertion -- see SAFETY comment on buildLeafCommand
    builderArgs as unknown as CommandBuilderArguments<BaseFlags, [], Context>;
  return buildCommand(typedArgs);
};

const buildRouteNode = (node: RouteNode, brief: string): RoutingTarget => {
  if (node.kind === "leaf") {
    return buildLeafCommand(node.spec);
  }
  if (node.kind === "capability-leaf") {
    return buildCapabilityLeafCommand(node.spec);
  }
  const routes: Record<string, RoutingTarget> = {};
  for (const [name, child] of Object.entries(node.children)) {
    routes[name] = buildRouteNode(child, `The ${name} command group`);
  }
  return buildRouteMap({ docs: { brief }, routes });
};

/**
 * Fold a generated `RouteNode` (route) into stricli `RoutingTarget` children,
 * ready to merge into the root route map's `routes`.
 */
export const buildGeneratedRoutes = (
  node: RouteNode,
): Record<string, RoutingTarget> => {
  if (node.kind !== "route") {
    return {};
  }
  const routes: Record<string, RoutingTarget> = {};
  for (const [name, child] of Object.entries(node.children)) {
    routes[name] = buildRouteNode(child, `The ${name} command group`);
  }
  return routes;
};

const outputOnlyFlags = (): Record<string, unknown> => ({
  [RESERVED_FLAG_KEYS.output]: parsedStringFlag(
    "Output format: json | table | jsonl",
  ),
  [RESERVED_FLAG_KEYS.json]: booleanFlag(
    "Output JSON (= --output json)",
    false,
  ),
  [RESERVED_FLAG_KEYS.table]: booleanFlag(
    "Output a table (= --output table)",
    false,
  ),
});

const resourceLeafBrief = (spec: ResourceLeafSpec): string =>
  spec.kind === "list"
    ? "List the static reference resources exposed by the stella server"
    : `Read the ${spec.name} reference resource`;

const buildResourceLeaf = (spec: ResourceLeafSpec): RoutingTarget => {
  const builderArgs = {
    docs: { brief: resourceLeafBrief(spec) },
    parameters: { flags: outputOnlyFlags() },
    func: async function func(
      this: Context,
      parsedFlags: Record<string, unknown>,
    ): Promise<void> {
      await runResourceCommand({ context: this, flags: parsedFlags, spec });
    },
  };
  const typedArgs: CommandBuilderArguments<BaseFlags, [], Context> =
    // eslint-disable-next-line no-unsafe-type-assertion -- see SAFETY comment on buildLeafCommand
    builderArgs as unknown as CommandBuilderArguments<BaseFlags, [], Context>;
  return buildCommand(typedArgs);
};

const buildResourceNode = (
  node: ResourceNode,
  brief: string,
): RoutingTarget => {
  if (node.kind === "leaf") {
    return buildResourceLeaf(node.spec);
  }
  const routes: Record<string, RoutingTarget> = {};
  for (const [name, child] of Object.entries(node.children)) {
    routes[name] = buildResourceNode(child, `The ${name} command group`);
  }
  return buildRouteMap({ docs: { brief }, routes });
};

/**
 * Fold a generated resource `ResourceNode` (route) into a single stricli
 * `RouteMap` for the reserved `reference` top-level command (spec S5.4).
 */
export const buildResourceRoutes = (node: ResourceNode): RouteMap<Context> => {
  const routes: Record<string, RoutingTarget> = {};
  if (node.kind === "route") {
    for (const [name, child] of Object.entries(node.children)) {
      routes[name] = buildResourceNode(child, `The ${name} command group`);
    }
  }
  return buildRouteMap({
    docs: { brief: "Read the server's static reference resources" },
    routes,
  });
};

export type { RouteMap };
