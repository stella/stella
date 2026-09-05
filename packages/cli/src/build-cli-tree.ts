// Assembles a stricli `RoutingTarget` tree from a generated `RouteNode` (spec
// 051 S5.1). Each leaf becomes a `buildCommand` whose `func` delegates to the
// generic `runLeafCommand` executor; each route node becomes a `buildRouteMap`.
// stricli's own flag parsing is kept deliberately permissive (every value flag
// is an optional parsed string, booleans are optional): all validation and
// exit-code selection happen inside the executor, so `process.exitCode` is set
// precisely rather than defaulted by stricli.

import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  help,
  text_en,
  version,
} from "@stricli/core";
import type {
  Application,
  BaseFlags,
  Command,
  CommandBuilderArguments,
  RouteMap,
} from "@stricli/core";

import packageJson from "../package.json" with { type: "json" };
import { determineCommandExitCode } from "./cli-exit-code.js";
import { authRoute } from "./commands/auth.js";
import { compatibilityRoute } from "./commands/compatibility.js";
import { uploadCommand } from "./commands/upload.js";
import type { Context } from "./context.js";
import { expandSchemaDefs } from "./expand-schema-defs.js";
import { flagBrief } from "./flag-help.js";
import { generatedResourceTree } from "./generated/resource-tree.js";
import {
  buildInputContractHelp,
  formatInputExample,
} from "./input-contract-help.js";
import { exitCodeEntries } from "./mcp-constants.js";
import { buildCommonFlags, buildServerFlag } from "./output-flags.js";
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

/**
 * Every generated value flag is OPTIONAL at the stricli layer, and this shared
 * return type makes that non-negotiable: a flag builder that forgets
 * `optional: true` is a type error, not a runtime surprise. The invariant holds
 * because any field can instead be supplied through `--input`, and required-ness
 * is enforced after the `--input`/flag merge against the JSON schema. A required
 * stricli flag would reject the whole command the moment the field is omitted —
 * exactly the bug that made optional array flags (e.g. `--assignee-ids`)
 * unusable when left off.
 */
type OptionalStricliFlag = { readonly optional: true };

const parsedStringFlag = (brief: string) =>
  ({ brief, kind: "parsed", optional: true, parse: identity }) as const;

const variadicFlag = (brief: string) =>
  ({
    brief,
    kind: "parsed",
    variadic: true,
    optional: true,
    parse: identity,
  }) as const;

const booleanFlag = (brief: string, withNegated: boolean) =>
  ({ brief, kind: "boolean", optional: true, withNegated }) as const;

/**
 * Build the stricli flag for one capability/tool input field. The single
 * construction site for both the tool and capability command builders, so the
 * optional-at-the-stricli-layer invariant cannot drift between them. The return
 * annotation enforces it for every branch.
 */
export const buildFlag = (flagSpec: FlagSpec): OptionalStricliFlag => {
  const brief = flagBrief(flagSpec);
  if (flagSpec.kind === "boolean") {
    return booleanFlag(brief, true);
  }
  if (flagSpec.repeatable) {
    return variadicFlag(brief);
  }
  return parsedStringFlag(brief);
};

const hasLimitProp = (spec: LeafCommandSpec): boolean => {
  const properties = spec.inputSchema["properties"];
  if (typeof properties !== "object" || properties === null) {
    return false;
  }
  return "limit" in properties;
};

const buildLeafFlags = (spec: LeafCommandSpec): Record<string, unknown> => {
  const flags: Record<string, unknown> = buildCommonFlags();

  for (const flagSpec of spec.flags) {
    flags[flagKey(flagSpec)] = buildFlag(flagSpec);
  }

  // Reserved global flags every command carries (spec S1/S3).
  flags[RESERVED_FLAG_KEYS.input] = parsedStringFlag(
    "Full tool-args JSON ('<json>' | - stdin | @file); explicit value flags override matching paths in the JSON",
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
  return `${spec.description ?? `Run the ${spec.toolName} tool`}${inputHint}`;
};

/**
 * Every value flag is optional at the parser (a field may arrive through
 * `--input`), so the usage line brackets required flags too. This line states
 * the tool's actual requirement where the usage line cannot.
 */
const requiredFlagsLine = (
  flags: readonly { flag: string; required: boolean }[],
): string | undefined => {
  const required = flags.filter((flag) => flag.required).map((f) => f.flag);
  return required.length === 0
    ? undefined
    : `Required (as flags, or inside --input): ${required.join(", ")}`;
};

/** A route group's brief names the commands under it instead of a placeholder. */
const groupBrief = (name: string, children: Record<string, unknown>): string =>
  `${name} commands: ${Object.keys(children).join(", ")}`;

const fullDescription = ({
  brief,
  discriminatorInject,
  inputSchema,
  inputOnly,
  requiredPaths,
  requiredFlags,
}: {
  brief: string;
  discriminatorInject?: Readonly<Record<string, string>> | undefined;
  inputSchema: Record<string, unknown> | undefined;
  inputOnly: readonly string[];
  requiredPaths: readonly string[];
  requiredFlags: readonly { flag: string; required: boolean }[];
}): string | undefined => {
  const required = requiredFlagsLine(requiredFlags);
  const contract =
    inputSchema === undefined
      ? undefined
      : buildInputContractHelp({
          schema: inputSchema,
          inputOnly,
          requiredPaths,
        });
  if (
    required === undefined &&
    (contract === undefined || contract.fields.length === 0)
  ) {
    return undefined;
  }
  const lines = [brief];
  if (required !== undefined) {
    lines.push("", required);
  }
  if (contract === undefined || contract.fields.length === 0) {
    return lines.join("\n");
  }
  lines.push(
    "",
    "--input JSON fields (explicit value flags override matching JSON paths):",
    ...contract.fields.map((line) => `  ${line}`),
  );
  if (contract.example.status === "complete") {
    const example =
      discriminatorInject === undefined
        ? contract.example.value
        : { ...contract.example.value, ...discriminatorInject };
    lines.push(
      "",
      "Complete JSON example:",
      `  ${formatInputExample(example)}`,
    );
  } else {
    lines.push(
      "",
      "JSON example unavailable; compose --input from the fields above.",
    );
  }
  return lines.join("\n");
};

const buildLeafCommand = (spec: LeafCommandSpec): RoutingTarget => {
  const flags = buildLeafFlags(spec);
  const brief = leafBrief(spec);
  const description = fullDescription({
    brief,
    discriminatorInject: spec.discriminatorInject,
    inputSchema: spec.inputSchema,
    inputOnly: spec.inputOnly,
    requiredPaths: spec.flags
      .filter((flag) => flag.required)
      .map((flag) => flag.prop),
    requiredFlags: spec.flags,
  });
  const builderArgs = {
    docs: {
      brief,
      ...(description === undefined ? {} : { fullDescription: description }),
    },
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
  // Stated first and unconditionally: the command covers only this
  // capability's JSON modes, and a user who came looking for the file mode has
  // to learn that here rather than from a confusing server refusal.
  const filelessHint =
    spec.filelessField === undefined
      ? ""
      : ` (JSON modes only: ${spec.filelessField} takes a file, which this command cannot send)`;
  if (spec.inputOnly.length > 0) {
    return `${filelessHint} (via --input only: ${spec.inputOnly.join(", ")})`;
  }
  return filelessHint;
};

/**
 * The command's `--help` brief. The catalog's authored description is the whole
 * point of the single-registry design, so it wins outright; the id-derived line
 * survives only as the fallback for a capability that has not been given a
 * description yet (a shrinking set, listed by id in
 * apps/api/capability-description-ledger.json).
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
  const flags: Record<string, unknown> = buildCommonFlags();

  for (const flagSpec of spec.flags) {
    flags[flagKey(flagSpec)] = buildFlag(flagSpec);
  }

  flags[RESERVED_FLAG_KEYS.input] = parsedStringFlag(
    "Full capability input JSON ({ body?, params?, query? }: '<json>' | - stdin | @file); explicit value flags override matching paths in the JSON",
  );
  flags[RESERVED_FLAG_KEYS.noInput] = booleanFlag(
    "Never prompt; fail closed (exit 7) where a confirmation is required",
    false,
  );
  if (spec.access === "write") {
    flags[RESERVED_FLAG_KEYS.dryRun] = booleanFlag(
      "Validate the input server-side and return without executing (validate_only)",
      false,
    );
  }

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

  // A write capability carries the server's per-capability confirm gate, so it
  // accepts --yes (pre-approve) alongside the TTY prompt/retry flow; a read has
  // nothing to confirm.
  if (spec.access === "write") {
    flags[RESERVED_FLAG_KEYS.yes] = booleanFlag(
      "Skip the destructive-op confirmation prompt",
      false,
    );
  }

  return flags;
};

const buildCapabilityLeafCommand = (
  spec: CapabilityLeafSpec,
): RoutingTarget => {
  const flags = buildCapabilityLeafFlags(spec);
  const brief = capabilityLeafBrief(spec);
  const description = fullDescription({
    brief,
    // Help must read the same shape `--input` validates against. The baked
    // schema is `$defs`-compacted, and the contract renderer does not resolve
    // refs, so documenting the stored form would describe a referenced object
    // as an opaque JSON value and could advertise an example the executor then
    // rejects. Expansion is per-command, on the help path only.
    inputSchema: expandSchemaDefs(spec.inputSchema) ?? spec.inputSchema,
    inputOnly: spec.inputOnly,
    requiredPaths: spec.flags
      .filter((flag) => flag.required)
      .map((flag) => `${flag.part}.${flag.partPath}`),
    requiredFlags: spec.flags,
  });
  const builderArgs = {
    docs: {
      brief,
      ...(description === undefined ? {} : { fullDescription: description }),
    },
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
    routes[name] = buildRouteNode(child, routeBrief(name, child));
  }
  return buildRouteMap({ docs: { brief }, routes });
};

const routeBrief = (name: string, node: RouteNode): string =>
  node.kind === "route" ? groupBrief(name, node.children) : name;

/**
 * Fold a generated `RouteNode` (route) into stricli `RoutingTarget` children,
 * ready to merge into the root route map's `routes`.
 */
const buildGeneratedRoutes = (
  node: RouteNode,
): Record<string, RoutingTarget> => {
  if (node.kind !== "route") {
    return {};
  }
  const routes: Record<string, RoutingTarget> = {};
  for (const [name, child] of Object.entries(node.children)) {
    routes[name] = buildRouteNode(child, routeBrief(name, child));
  }
  return routes;
};

const resourceLeafBrief = (spec: ResourceLeafSpec): string =>
  spec.kind === "list"
    ? "List the static reference resources exposed by the stella server"
    : `Read the ${spec.name} reference resource`;

const buildResourceLeaf = (spec: ResourceLeafSpec): RoutingTarget => {
  const builderArgs = {
    docs: { brief: resourceLeafBrief(spec) },
    parameters: { flags: buildCommonFlags() },
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
    routes[name] = buildResourceNode(child, resourceBrief(name, child));
  }
  return buildRouteMap({ docs: { brief }, routes });
};

const resourceBrief = (name: string, node: ResourceNode): string =>
  node.kind === "route" ? groupBrief(name, node.children) : name;

/**
 * Fold a generated resource `ResourceNode` (route) into a single stricli
 * `RouteMap` for the reserved `reference` top-level command (spec S5.4).
 */
const buildResourceRoutes = (node: ResourceNode): RouteMap<Context> => {
  const routes: Record<string, RoutingTarget> = {};
  if (node.kind === "route") {
    for (const [name, child] of Object.entries(node.children)) {
      routes[name] = buildResourceNode(child, resourceBrief(name, child));
    }
  }
  return buildRouteMap({
    docs: { brief: "Read the server's static reference resources" },
    routes,
  });
};

export type { RouteMap };

const collectLeafPaths = (
  node: RouteNode,
  path: readonly string[],
  lines: string[],
): void => {
  if (node.kind === "leaf") {
    lines.push(`${path.join(" ")}\t(${node.spec.toolName})`);
    return;
  }
  if (node.kind === "capability-leaf") {
    lines.push(
      `${path.join(" ")}\t(invoke_capability: ${node.spec.capabilityId})`,
    );
    return;
  }
  for (const [name, child] of Object.entries(node.children)) {
    collectLeafPaths(child, [...path, name], lines);
  }
};

/** The root `--help` body: the exit-code contract, rendered from EXIT_CODES. */
const rootFullDescription = (): string =>
  [
    "Stella command-line client.",
    "",
    "Exit codes:",
    ...exitCodeEntries().map(
      ({ code, meaning }) => `  ${String(code).padStart(2, " ")}  ${meaning}`,
    ),
  ].join("\n");

const HELP_FORMATTING = {
  useAliasInUsageLine: false,
  onlyRequiredInUsageLine: false,
  caseStyle: "convert-camel-to-kebab",
} as const;

const buildRootRoute = (tree: RouteNode): RouteMap<Context> => {
  const toolsListCommand = buildCommand<
    { readonly server: string | undefined },
    [],
    Context
  >({
    docs: {
      brief:
        "List the CLI commands generated from the stella MCP tool registry",
    },
    func(this: Context): void {
      const lines: string[] = [];
      // Reflect the ACTIVE tree (the cached-listings tree when the server
      // registry has diverged), not the baked-in one.
      collectLeafPaths(tree, [], lines);
      this.process.stdout.write(`${lines.sort().join("\n")}\n`);
    },
    parameters: { flags: buildServerFlag() },
  });

  const toolsRoute = buildRouteMap({
    docs: { brief: "Inspect the generated command registry" },
    routes: { list: toolsListCommand },
  });

  return buildRouteMap({
    docs: {
      brief: "Stella command-line client",
      fullDescription: rootFullDescription(),
    },
    routes: {
      auth: authRoute,
      compatibility: compatibilityRoute,
      upload: uploadCommand,
      tools: toolsRoute,
      reference: buildResourceRoutes(generatedResourceTree),
      ...buildGeneratedRoutes(tree),
    },
  });
};

/**
 * The whole stricli application, assembled from the ACTIVE command tree. It
 * lives here rather than in `cli.ts` so tests can walk the real route tree the
 * CLI dispatches against instead of a re-wired copy of it.
 */
export const buildApp = (tree: RouteNode): Application<Context> =>
  buildApplication(
    buildRootRoute(tree),
    {
      name: "stella",
      // A hand-written command's returned `CliCommandError` carries its exit
      // class; anything else that escapes is an unexpected error, never 1 by
      // stricli default.
      determineExitCode: determineCommandExitCode,
      // Renders (and accepts) multi-word flags as kebab-case, e.g. the
      // `noInput` flag as `--no-input` rather than `--noInput` — matches the
      // documented command surface and every other kebab-case CLI convention
      // (gh, npm, docker).
      scanner: { caseStyle: "allow-kebab-for-camel" },
    },
    {
      help: help({
        brief: text_en.briefs.help,
        defaultForRouteMap: true,
        formatting: HELP_FORMATTING,
      }),
      helpAll: help({
        brief: text_en.briefs.helpAll,
        alias: "H",
        hidden: true,
        includeHidden: true,
        formatting: HELP_FORMATTING,
      }),
      version: version({
        brief: text_en.briefs.version,
        info: { currentVersion: packageJson.version },
      }),
    },
  );
