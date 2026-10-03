/**
 * The shapes a tool surface is built from. Nothing here knows about a
 * transport, a schema library, or the product serving the tools: a tool is a
 * name, a JSON Schema, and an async function, and every answer is either a
 * JSON payload or one error shape.
 */

/** A JSON payload: finite numbers and acyclic JSON data are checked at serialization. */
export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpJsonValue[]
  | { readonly [key: string]: McpJsonValue };

/** A JSON Schema object, as plain JSON. */
export type McpJsonSchema = Readonly<Record<string, unknown>>;

/** Whether a call only reads or may change state. */
export type ToolAccess = "read" | "write";

/** One problem with one input value. */
export type ToolInputIssue = {
  readonly path: string;
  readonly message: string;
};

/**
 * The one error shape every tool answers with. `code` is machine-readable,
 * `hint` says what to do next, and `retryable` says whether the same call
 * can succeed once the caller has done it (re-read, waited).
 */
export type ToolError = {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly issues?: readonly ToolInputIssue[];
  readonly details?: unknown;
};

/** The success payload or structured failure returned by a tool handler. */
export type ToolOutcome =
  | { readonly ok: true; readonly value: McpJsonValue }
  | { readonly ok: false; readonly error: ToolError };

/** A tool registry entry, independent of transport and schema library. */
export type ToolDefinition<Context> = {
  readonly name: string;
  /** One short sentence. A direct tool sends it on every turn, so every word costs. */
  readonly summary: string;
  /** Longer guidance, sent only by `describe_capability`. */
  readonly guide?: string;
  /** Short guidance appended by opt-in outline discovery. */
  readonly brief?: string;
  readonly access: ToolAccess;
  /** Whether a call can destroy or replace state. Defaults to `access === "write"`. */
  readonly destructive?: boolean;
  /** Groups lazy tools for `list_capabilities`' `domain` filter. */
  readonly domain?: string;
  /** Every argument the tool accepts: what calls are checked against. */
  readonly inputSchema: McpJsonSchema;
  /** A representative invocation input; compact discovery falls back to an empty skeleton if it exceeds the budget. */
  readonly exampleInput?: Readonly<Record<string, unknown>>;
  /**
   * Optional schema used for the compact parameter outline. Full discovery
   * returns it when the surface opts into `fullSchema: "described"`.
   */
  readonly describedSchema?: McpJsonSchema;
  /**
   * Present for a tool listed on every turn, with the compact schema it is
   * listed with. A tool without it is reached through the capability tools.
   */
  readonly direct?: { readonly inputSchema: McpJsonSchema };
  /**
   * Properties read exactly as sent, never leniently: switches that widen
   * what a call may do (overwrite, repack) must be JSON `true` to count.
   */
  readonly exactProperties?: readonly string[];
  readonly run: (
    args: Record<string, unknown>,
    context: Context,
  ) => Promise<ToolOutcome>;
};

/** A tool as `tools/list` advertises it. */
export type ListedTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; [keyword: string]: unknown };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
};

/** A `tools/call` answer: a JSON payload or `{ error }`, as text. */
export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
};
