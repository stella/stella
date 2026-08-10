import type {
  CallToolResult,
  JsonSchemaType,
  Tool as McpTool,
} from "@modelcontextprotocol/server";

import type { env } from "@/api/env";
import type {
  MCP_ALL_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { TextWindowResult } from "@/api/mcp/tool-utils";

/**
 * v2 types `Tool["inputSchema"]` as an arbitrary JSON value, which loses the
 * object shape every tool definition here writes. `JsonSchemaType` is the
 * schema-shaped type the SDK itself accepts, so tools keep their literal shapes.
 */
export type JsonSchema = JsonSchemaType;

/**
 * Every MCP tool accepts one named-argument object, never a scalar root. The
 * authoring type also accepts TypeBox/Elysia's runtime schemas, which carry
 * non-enumerable symbols beyond their JSON fields. Wire projections rebuild
 * and validate the enumerable JSON recursively, so those symbols never enter
 * the protocol payload.
 */
export type McpToolInputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ToolScope = (typeof MCP_ALL_RESOURCE_SCOPES)[number];

/**
 * Deployment feature flag that gates a tool's backing surface. Derived
 * structurally from the `FEATURE_*` keys of the API env schema, so a tool can
 * only name a flag that actually exists: a typo or a removed flag fails
 * typecheck. A tool tagged with a flag is advertised and dispatchable only when
 * that flag is on (or the deployment is running in dev); see
 * `isMcpToolFeatureEnabled` in `gateway/list-tools.ts`.
 */
export type McpToolFeatureFlag = Extract<keyof typeof env, `FEATURE_${string}`>;

/**
 * Closed set of reasons a tool is kept off the anonymized surface. No
 * freetext: adding a tool forces one of these, and the projection in
 * `static-tool-definitions.ts` can only reason about known reasons.
 */
export const MCP_ANONYMIZED_EXCLUSION_REASONS = [
  /** Mutating tool. The anonymized surface is egress-only, so writes never appear. */
  "write",
  /**
   * User-managed skill or external MCP connector tool. These are resolved by the
   * dynamic gateway (default mode only) and are never part of the anonymized
   * surface.
   */
  "dynamic_gateway",
  /**
   * Read tool whose payload embeds tenant-authored text in a structurally
   * dynamic shape the egress pipeline cannot enumerate field-by-field (e.g. the
   * audit log's free-form `changes`/`metadata` JSON diffs, which can hold any
   * matter/contact/document name a mutation touched). Declaring a fixed
   * `textFields` list would silently leak whatever the list missed, so the tool
   * fails closed and is excluded from the anonymized surface entirely.
   */
  "dynamic_tenant_payload",
] as const;

export type McpAnonymizedExclusionReason =
  (typeof MCP_ANONYMIZED_EXCLUSION_REASONS)[number];

/**
 * Every tool declares how it behaves on the anonymized MCP surface. The
 * anonymized tool list and its `stella:*_anonymized` scopes are a pure
 * projection of this policy (see `static-tool-definitions.ts`), so a tool
 * cannot appear in anonymized mode without an explicit decision here.
 */
export type McpAnonymizedPolicy =
  | {
      exposure: "anonymize";
      /**
       * Output text fields the central egress pipeline redacts before
       * windowing, in the order they are fed to the redactor. Documents the
       * egress contract; the registry test asserts it is non-empty.
       */
      textFields: readonly string[];
      /**
       * Description shown on the anonymized surface when it must differ from the
       * default description (e.g. "Search anonymized knowledge ..."). Omitted
       * when the default description already fits.
       */
      description?: string;
    }
  | { exposure: "passthrough" }
  | { exposure: "excluded"; reason: McpAnonymizedExclusionReason };

/**
 * Closed set of mutation levels a tool can declare. `write` covers any
 * handler that changes tenant state: DB inserts/updates/deletes, enqueuing a
 * workflow, or metering usage. Everything else is `read`. Required on every
 * tool (no default) so a new tool cannot land without an explicit call; this
 * is the structural signal the chat code-mode projection selects read-only
 * tools by, instead of the annotations below (optional, client-hint-only) or
 * the anonymized-exclusion `"write"` reason (a narrower, egress-specific
 * consequence of the same fact). The registry-quality suite cross-checks all
 * three stay coherent.
 */
export const MCP_TOOL_ACCESS_LEVELS = ["read", "write"] as const;

export type McpToolAccess = (typeof MCP_TOOL_ACCESS_LEVELS)[number];

export type McpToolDefinition = {
  /**
   * Host-extension metadata served verbatim through `tools/list`. Keep it on
   * the canonical definition so MCP Apps and host-specific transports cannot
   * grow a second registry beside the in-app chat and CLI projections.
   */
  _meta?: McpTool["_meta"];
  access: McpToolAccess;
  /**
   * Extra grants required in addition to the primary `scope`. Discovery and
   * dispatch both enforce this list centrally, so compound operations cannot
   * be advertised or called with only one half of their consent contract.
   */
  additionalScopes?: readonly ToolScope[];
  /**
   * MCP client-hint annotations. Required, and `title` is required within it
   * (no default), so a new tool cannot land without a human-readable display
   * name; clients render `title` in tool listings and consent prompts where
   * the `verb_noun` wire name would read poorly. The behavioural hints stay
   * optional; the registry-quality suite enforces their coherence and the
   * title style.
   */
  annotations: NonNullable<McpTool["annotations"]> & { title: string };
  anonymized: McpAnonymizedPolicy;
  description: string;
  /**
   * Deployment feature flag gating this tool. When set, the tool is dropped
   * from the advertised list and its dispatch is rejected unless the flag is on
   * (or the deployment runs in dev). Omitted for always-available tools.
   */
  feature?: McpToolFeatureFlag;
  inputSchema: McpToolInputSchema;
  /**
   * Optional session-member visibility predicate, enforced centrally for both
   * discovery and dispatch. Internal registry metadata; never projected onto
   * the MCP wire shape.
   */
  isVisibleToMemberRole?: (
    memberRole: McpRequestContext["memberRole"],
  ) => boolean;
  name: string;
  scope: ToolScope;
};

type DefaultMcpResourceScope = (typeof MCP_DEFAULT_RESOURCE_SCOPES)[number];

type BareMcpResourceScope<TScope extends `stella:${string}`> =
  TScope extends `stella:${infer TName}` ? TName : never;

const MCP_CLI_TOOL_SCOPE_BY_RESOURCE_SCOPE = {
  "stella:read": "read",
  "stella:contacts_write": "contacts_write",
  "stella:matters_write": "matters_write",
  "stella:chat": "chat",
  "stella:documents_write": "documents_write",
  "stella:knowledge_write": "knowledge_write",
  "stella:search": "search",
  "stella:onboarding": "onboarding",
  "stella:templates": "templates",
  "stella:billing_write": "billing_write",
  "stella:admin_read": "admin_read",
  "stella:admin_write": "admin_write",
  "stella:feedback": "feedback",
  "stella:skills": null,
  "stella:external_mcps": null,
} as const satisfies {
  [TScope in DefaultMcpResourceScope]: BareMcpResourceScope<TScope> | null;
};

export type McpCliToolScope = Exclude<
  (typeof MCP_CLI_TOOL_SCOPE_BY_RESOURCE_SCOPE)[DefaultMcpResourceScope],
  null
>;

export const MCP_CLI_TOOL_SCOPES: readonly McpCliToolScope[] = Object.values(
  MCP_CLI_TOOL_SCOPE_BY_RESOURCE_SCOPE,
).filter((scope): scope is McpCliToolScope => scope !== null);

export type McpCliDiscriminatorSubcommand = {
  command: string;
  destructive?: true;
  include?: readonly string[];
  required?: readonly string[];
};

export type McpCliToolAnnotation = {
  command: readonly string[];
  additionalScopes?: readonly McpCliToolScope[];
  /** API-owned finite transport deadline projected into generated CLI leaves. */
  requestTimeoutMs?: number;
  excluded?: true;
  scope?: McpCliToolScope;
  itemsKey?: string;
  singleReadWhen?: string;
  columns?: readonly string[];
  windowedText?: true;
  paginationless?: true;
  inputOnly?: readonly string[];
  discriminator?: {
    prop: string;
    subcommands: Record<string, McpCliDiscriminatorSubcommand>;
  };
  flagRename?: Record<string, string>;
  /**
   * The tool is not destructive itself but gates SOME calls behind its `confirm`
   * arg (per-target destructiveness, e.g. `invoke_capability` where the invoked
   * capability's catalog flag decides). The CLI leaf then accepts `--yes`
   * (injecting `confirm: true` upfront) and, on a `confirmation_required`
   * envelope at a TTY, prompts and retries once with `confirm: true`.
   */
  confirmPassthrough?: true;
};

export type McpCliToolAnnotationMap<
  TDefinitions extends readonly McpToolDefinition[],
> = Readonly<Record<TDefinitions[number]["name"], McpCliToolAnnotation>>;

export const defineMcpCliToolAnnotations = <
  const TDefinitions extends readonly McpToolDefinition[],
  const TAnnotations extends McpCliToolAnnotationMap<TDefinitions>,
>(
  _definitions: TDefinitions,
  annotations: TAnnotations &
    Record<Exclude<keyof TAnnotations, TDefinitions[number]["name"]>, never>,
): McpCliToolAnnotationMap<TDefinitions> => annotations;

/**
 * Compat search hit before egress. Carries `workspaceId` so the egress pipeline
 * can group per-workspace anonymization; the field is stripped before the
 * result reaches the client.
 */
export type McpCompatSearchResult = {
  id: string;
  title: string;
  url: string;
  workspaceId: string;
};

/**
 * One anonymizable text field inside a generic `structured` egress payload.
 * `workspaceId` is the anonymization scope: a real workspace id for
 * matter/document payloads, or the organization id for org-scoped payloads
 * (contacts, templates). Fields sharing a scope are batched into a single
 * `anonymizeTextFields` call so placeholders stay consistent across them.
 * `apply` writes the anonymized value back into the payload the plan carries
 * (in default mode the field is left exactly as the handler produced it).
 */
export type McpStructuredTextField = {
  apply: (value: string) => void;
  value: string;
  workspaceId: string;
};

/**
 * Optional post-anonymization windowing of one text field on a `structured`
 * plan. `read` returns the full text to window (already anonymized in
 * anonymized mode, because the text field ran through `textFields` first);
 * `apply` writes the windowed slice plus its cursor/charCount/truncated
 * metadata back into the payload. Windowing runs after anonymization so an
 * entity name can never be split across a window edge.
 */
export type McpStructuredWindow = {
  apply: (window: TextWindowResult) => void;
  cursor: string | undefined;
  maxChars: number;
  read: () => string;
};

/**
 * A handler either returns a finished `CallToolResult`, or an egress plan the
 * dispatch layer finalizes (anonymize declared text fields, then window, then
 * serialize). Egress plans keep the full, pre-window, un-anonymized payload so
 * the central pipeline can anonymize before it windows, without the handler
 * ever seeing the request mode.
 *
 * The `structured` variant is the generic shape: the handler builds the whole
 * response object and declares which text fields to anonymize (with per-field
 * workspace attribution, so multi-tenant payloads like search hits and matter
 * lists group correctly) plus an optional field to window afterwards. The
 * `compatSearch`/`compatFetch` variants predate it and stay as-is: they carry
 * OpenAI-compatible-specific shaping (workspaceId stripping, anonymization
 * metadata) that does not generalize.
 */
export type McpEgressPlan =
  | {
      egress: "compatSearch";
      nextCursor: string | null | undefined;
      results: readonly McpCompatSearchResult[];
    }
  | {
      egress: "compatFetch";
      cursor: string | undefined;
      id: string;
      maxChars: number;
      text: string;
      title: string;
      url: string;
      workspaceId: string;
    }
  | {
      egress: "structured";
      payload: unknown;
      textFields: readonly McpStructuredTextField[];
      window?: McpStructuredWindow;
    };

export type McpToolResponse = CallToolResult | McpEgressPlan;

export const isMcpEgressPlan = (
  response: McpToolResponse,
): response is McpEgressPlan =>
  // SAFETY: `CallToolResult` has no `egress` key, so its presence discriminates
  // the egress-plan variants from a finished result. `CallToolResult` is an
  // external SDK type we cannot brand with a shared discriminator.
  "egress" in response;

export type McpToolHandler = ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}) => McpToolResponse | Promise<McpToolResponse>;

export type McpToolHandlerMap<
  TDefinitions extends readonly McpToolDefinition[],
> = Readonly<Record<TDefinitions[number]["name"], McpToolHandler>>;

export type McpToolSet<TDefinitions extends readonly McpToolDefinition[]> = {
  readonly definitions: TDefinitions;
  readonly handlers: McpToolHandlerMap<TDefinitions>;
};

/**
 * Binds advertised tool definitions to their dispatch handlers in one typed
 * value. Adding, removing, or renaming a static tool now forces the handler map
 * to change in the same module; the central registry derives both surfaces from
 * these sets instead of maintaining a second name list.
 */
export const defineMcpToolSet = <
  const TDefinitions extends readonly McpToolDefinition[],
  const THandlers extends McpToolHandlerMap<TDefinitions>,
>(
  definitions: TDefinitions,
  handlers: THandlers &
    Record<Exclude<keyof THandlers, TDefinitions[number]["name"]>, never>,
): McpToolSet<TDefinitions> => ({ definitions, handlers });

/**
 * Foundation for expressing one anonymizable text field as code instead of a
 * hand-written `textFields` path string (design brief plan 049, Option B).
 * `items` extracts the field's target items live from the actual payload
 * object a handler is about to return, so a write-back through `apply`
 * always lands on the object reference the client receives - this closes,
 * structurally, the specific class of bug where a push closure mutates a
 * copy the served payload was built from instead of the served object
 * itself (see the `readMatterOverview` fix in `stella-tools.ts` for a real,
 * shipped instance of exactly that mistake).
 *
 * `path` stays a human/agent-facing documentation string, mirroring today's
 * hand-written `textFields` entries; `deriveTextFieldPaths` in
 * `text-field-spec.ts` turns a spec list into that documented list
 * mechanically, so the declaration and the code that actually walks the
 * payload can no longer name different fields.
 *
 * `TItem` is intentionally not a parameter of this public type: one tool's
 * spec list mixes fields over different item shapes (a matter, a recent
 * entity, a contact card, ...), so a list of specs for one tool is
 * necessarily item-shape-heterogeneous. Author a spec through
 * `defineTextFieldSpec` (generic over `TItem`) in `text-field-spec.ts`,
 * which stores it here item-shape-erased.
 *
 * This type has no consumer yet: wiring a real tool's `textFields` through
 * a spec is a per-module migration, out of scope for this foundational
 * commit (see plan 049 Phases 2+).
 */
export type McpTextFieldSpec<TPayload> = {
  /** Documentation-only path, mirroring today's hand-written textFields entries. */
  path: string;
  /** Collects live text fields while retaining the private item shape in its closure. */
  collect: (payload: TPayload) => McpStructuredTextField[];
};
