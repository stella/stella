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
  | "documents_write"
  | "knowledge_write"
  | "search"
  | "onboarding"
  | "templates"
  | "billing_write"
  | "admin_read"
  | "admin_write";

/** Wire fields from `tools/list` (build-time: projected from `DEFAULT_MCP_TOOL_DEFINITIONS`). */
export type RegistryToolListing = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
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
  scope?: ToolScope;
  inputSchema: JsonSchema;
};

/** stricli assembly: `LeafCommandSpec[]` folds into a nested route tree. */
export type RouteNode =
  | { kind: "leaf"; spec: LeafCommandSpec }
  | { kind: "route"; children: Record<string, RouteNode> };
