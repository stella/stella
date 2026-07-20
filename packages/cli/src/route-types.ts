// Data shapes for the JSON-Schema -> stricli route-map generator.
//
// This module is types only (spec 051 S5.1). The generator itself
// (`generateRouteMap`), the annotation table (S1), and every domain command
// are out of scope for this phase; see `src/generated/route-map.ts` for the
// placeholder the real generator will replace.

/** A JSON Schema fragment, as emitted by the MCP tool registry's prop builders. */
export type JsonSchema = Record<string, unknown>;

/** The MCP scope strings a tool annotation can require (client-side precheck only). */
export type ToolScope =
  | "read"
  | "matters_write"
  | "chat"
  | "documents_write"
  | "knowledge_write"
  | "search"
  | "onboarding"
  | "templates"
  | "billing_write"
  | "admin_read"
  | "admin_write"
  | "feedback";

/** Wire fields from `tools/list` (build-time: projected from `DEFAULT_MCP_TOOL_DEFINITIONS`). */
export type RegistryToolListing = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/** One required-enum subcommand produced by a discriminator split (spec S2). */
export type DiscriminatorSubcommand = {
  command: string;
  destructive?: true;
  include?: readonly string[];
  required?: readonly string[];
};

/** Baked-in per-tool annotation (spec S1), keyed by tool name and merged with the listing. */
export type ToolAnnotation = {
  command: readonly string[];
  excluded?: true;
  scope?: ToolScope;
  itemsKey?: string;
  singleReadWhen?: string;
  columns?: readonly string[];
  windowedText?: true;
  paginationless?: true;
  inputOnly?: readonly string[];
  discriminator?: {
    prop: string;
    subcommands: Record<string, DiscriminatorSubcommand>;
  };
  flagRename?: Record<string, string>;
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
  flag: string;
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
  toolName: string;
  discriminatorInject?: Record<string, string>;
  flags: readonly FlagSpec[];
  inputOnly: readonly string[];
  paginated: boolean;
  windowedText: boolean;
  itemsKey?: string;
  destructive: boolean;
  /** See `ToolAnnotation.confirmPassthrough`: --yes / prompt-retry confirm flow. */
  confirmPassthrough?: true;
  scope?: ToolScope;
  inputSchema: JsonSchema;
};

/** Which part of a capability's input a generated flag routes into (spec 049). */
export type CapabilityPart = "body" | "params" | "query";

/**
 * One generated flag on a capability leaf: a `FlagSpec` tagged with the input
 * part it routes into. `FlagSpec.prop` drives the stricli flag identity (the
 * user-facing flag name), while `part` + `partPath` drive where the coerced
 * value lands inside the `invoke_capability` `input` object (`input[part]` at
 * `partPath`). For a flag whose bare name is unique they coincide; on a
 * cross-part or reserved-flag collision the generator part-prefixes `prop`
 * (e.g. `query.version` -> `--query-version`) while `partPath` stays the raw
 * property path (`version`).
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
  /**
   * Synthesized `{ body?, params?, query? }` wrapper schema validated against
   * the `--input` payload. Absent when the catalog entry's schema was truncated
   * (`schemaTruncated`): then `--input` is passed through unvalidated (the
   * server still validates against the live handler schema).
   */
  inputSchema?: JsonSchema;
  /** The catalog entry carried `inputSchemaTruncated`: no flags, `--input` only. */
  schemaTruncated: boolean;
};

/** stricli assembly: `LeafCommandSpec[]` folds into a nested route tree. */
export type RouteNode =
  | { kind: "leaf"; spec: LeafCommandSpec }
  | { kind: "capability-leaf"; spec: CapabilityLeafSpec }
  | { kind: "route"; children: Record<string, RouteNode> };
