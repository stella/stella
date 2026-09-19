// Data shapes for the JSON-Schema -> stricli route-map generator.
//
// Shared transport limits live beside the shapes they constrain.

import type { McpCliToolScope } from "./generated/mcp-contract.js";

/** A JSON Schema fragment, as emitted by the MCP tool registry's prop builders. */
export type JsonSchema = Record<string, unknown>;

/** Maximum finite transport deadline an API capability may project into the CLI. */
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

/** The MCP scope strings a tool annotation can require (client-side precheck only). */
export type ToolScope = McpCliToolScope;

/** Wire fields from `tools/list` (build-time: projected from `DEFAULT_MCP_TOOL_DEFINITIONS`). */
export type RegistryToolListing = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/** One required-enum subcommand produced by a discriminator split (spec S2). */
export type DiscriminatorSubcommand = {
  command: string;
  destructive?: boolean;
  include?: readonly string[];
  required?: readonly string[];
};

/** Baked-in per-tool annotation (spec S1), keyed by tool name and merged with the listing. */
export type ToolAnnotation = {
  command: readonly string[];
  additionalScopes?: readonly ToolScope[];
  /** API-owned finite transport deadline for this generated tool. */
  requestTimeoutMs?: number;
  excluded?: true;
  scope?: ToolScope;
  itemsKey?: string;
  singleReadWhen?: string;
  columns?: readonly string[];
  /** See the API-side annotation: where the windowed text lives in the payload. */
  windowedText?: { textPath: string };
  paginationless?: true;
  /** See the API-side annotation: a per-entry cursor cannot be followed. */
  perEntryCursor?: true;
  inputOnly?: readonly string[];
  discriminator?: {
    prop: string;
    subcommands: Record<string, DiscriminatorSubcommand>;
  };
  flagRename?: Record<string, string>;
  /** See the API-side annotation: the base64 prop `--file <path>` fills. */
  localFileBase64Prop?: string;
  /**
   * The tool is not destructive itself but gates SOME calls behind its
   * `confirm` arg (per-target destructiveness, e.g. `invoke_capability`). The
   * leaf accepts `--yes` (injects `confirm: true` upfront) and, on a
   * `confirmation_required` envelope at a TTY, prompts and retries once.
   */
  confirmPassthrough?: true;
};

/** One generated CLI flag, derived from an `inputSchema` prop (spec S3). */
export type FlagSpec = {
  /** Canonical public long flag name, separate from its destination path. */
  flag: string;
  /** Input destination path; it need not match the public flag name. */
  prop: string;
  kind:
    | "string"
    | "int"
    | "number"
    | "boolean"
    | "enum"
    | "nullable-string"
    | "string-array"
    | "int-array"
    | "enum-array";
  required: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  repeatable: boolean;
  default?: unknown;
  /**
   * Per-property prose from the source JSON Schema's `description` (an Elysia
   * `t.String({ description })` on the handler config, or a curated tool's
   * hand-written property description). Rendered ahead of the mechanical
   * type/required suffix in the flag's `--help` brief.
   */
  description?: string;
};

/** The generator's per-leaf output before handing to stricli's `buildCommand`. */
export type LeafCommandSpec = {
  commandPath: readonly string[];
  additionalScopes?: readonly ToolScope[];
  requestTimeoutMs?: number;
  toolName: string;
  /** The tool's authored description, first sentence; the command's `--help` brief. */
  description?: string;
  discriminatorInject?: Record<string, string>;
  flags: readonly FlagSpec[];
  inputOnly: readonly string[];
  paginated: boolean;
  /**
   * Whether the leaf offers `--all`. False where the payload's continuation is
   * per entry: the follow loop advances one top-level cursor, and following
   * nothing would return the first window as though it were the whole text.
   */
  followable: boolean;
  windowedText: boolean;
  /**
   * Dot-separated path to the windowed text in the payload, present exactly
   * when `windowedText` is true. A nested read (`statute.text`) renders and
   * concatenates from here, so `--all` cannot silently join empty chunks.
   */
  textPath?: string;
  itemsKey?: string;
  destructive: boolean;
  /** See `ToolAnnotation.confirmPassthrough`: --yes / prompt-retry confirm flow. */
  confirmPassthrough?: true;
  /**
   * Input prop `--file <path>` fills with the local file's base64. Present
   * exactly when the leaf offers `--file`; the ceiling is read from this prop's
   * `maxLength` in `inputSchema`, never restated here.
   */
  localFileBase64Prop?: string;
  scope?: ToolScope;
  inputSchema: JsonSchema;
};

/** Which part of a capability's input a generated flag routes into (spec 049). */
export const CAPABILITY_PARTS = ["params", "body", "query"] as const;

export type CapabilityPart = (typeof CAPABILITY_PARTS)[number];

/**
 * One generated flag on a capability leaf: a `FlagSpec` tagged with the input
 * part it routes into. `FlagSpec.flag` is the canonical user-facing name;
 * `part` + `partPath` drive where the coerced value lands inside the
 * `invoke_capability` input object. `FlagSpec.prop` remains the unique local
 * destination identity used while resolving cross-part collisions.
 */
export type CapabilityFlagSpec = FlagSpec & {
  part: CapabilityPart;
  /** Property path WITHIN `part` (leaf name, or dotted for a depth-2 object). */
  partPath: string;
};

/**
 * A generated capability leaf (spec 049): reached through the generic
 * `invoke_capability` tool rather than a curated tool. `capabilityId` is the
 * catalog id; the executor calls `invoke_capability` with
 * `{ capability: capabilityId, input: { body?, params?, query? } }`.
 */
export type CapabilityLeafSpec = {
  commandPath: readonly string[];
  capabilityId: string;
  /** API-owned finite transport deadline for this generated capability command. */
  requestTimeoutMs?: number;
  /**
   * The catalog entry's `description`: the single authored sentence about what
   * this capability does, sourced from the handler config. Used verbatim as the
   * command's `--help` brief; absent entries fall back to an id-derived line.
   */
  description?: string;
  /**
   * Read vs. write, from the catalog entry. The executor surfaces the server's
   * request-id receipt on stderr only for a `write` (a mutation an operator may
   * need to reference), never for a read.
   */
  access: "read" | "write";
  flags: readonly CapabilityFlagSpec[];
  /** Part-qualified property paths reachable only through `--input` (spec S3). */
  inputOnly: readonly string[];
  paginated: boolean;
  /** The input part carrying the `cursor`/`limit` pagination props, when paginated. */
  paginationPart?: CapabilityPart;
  /** Result envelope items key for a list-shaped capability (`Page<T>` -> `items`). */
  itemsKey?: string;
  destructive: boolean;
  scope?: ToolScope;
  additionalScopes?: readonly ToolScope[];
  /**
   * Synthesized `{ body?, params?, query? }` wrapper schema validated against
   * the `--input` payload. Always present: every catalog entry carries a
   * complete input schema. Kept `$defs`-compacted here, the way the catalog
   * carries it; `--input` validation expands it (`expand-schema-defs.ts`).
   */
  inputSchema: JsonSchema;
  /**
   * Body field carrying an OPTIONAL file. The capability is generated (its other
   * modes are plain JSON) but this field is withheld from the flags and from the
   * `--input` schema, because no JSON value can stand in for the bytes. Named
   * here so `--help` can say so instead of leaving a silent gap between the
   * command and the REST endpoint.
   */
  filelessField?: string;
};

/**
 * Commands the connected server attested are gated off in this deployment.
 * They stay in the tree (invoking one yields the server's `feature_disabled`);
 * every listing marks them from this one value.
 */
export type DisabledCommands = {
  /** Curated tool names (`x-stella-feature-omitted-tools`). */
  tools: readonly string[];
  /** Catalog capability ids (`x-stella-feature-omitted-capabilities`). */
  capabilities: readonly string[];
};

/** No attestation: a server that sent no evidence, or no server at all. */
export const NO_DISABLED_COMMANDS: DisabledCommands = {
  tools: [],
  capabilities: [],
};

/** stricli assembly: `LeafCommandSpec[]` folds into a nested route tree. */
export type RouteNode =
  | { kind: "leaf"; spec: LeafCommandSpec }
  | { kind: "capability-leaf"; spec: CapabilityLeafSpec }
  | { kind: "route"; children: Record<string, RouteNode> };
