import type {
  JsonSchemaType,
  Tool as McpTool,
} from "@modelcontextprotocol/server";
import type * as v from "valibot";

import type { SearchPaginationOutcome } from "@stll/api-contract/search";

import type { AccountAccess } from "@/api/lib/api-handlers";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import type {
  MCP_ALL_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";
import type { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
import type { TextWindowResult } from "@/api/mcp/tool-utils";
import type { McpWriteToolPermissions } from "@/api/mcp/write-tool-authority";

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

/**
 * Stella-owned tools always return an object as structured content. The source
 * Valibot schema is retained beside its wire projection so the handler type,
 * advertised contract, and runtime validator are one value rather than three
 * hand-maintained mirrors.
 */
export type McpToolOutputSchema = NonNullable<McpTool["outputSchema"]>;

export type McpToolOutputContract<
  TData = unknown,
  TSchema extends v.GenericSchema = v.GenericSchema,
  TProjection extends "identity" | "explicit" = "identity" | "explicit",
> = {
  /** Type-only handler binding; factories intentionally omit it at runtime. */
  handlerDataType?: (data: TData) => void;
  outputSchema: McpToolOutputSchema;
  outputSchemaSource: TSchema;
  project: (data: unknown) => unknown;
  projection: TProjection;
};

export type RuntimeMcpToolOutputContract = Omit<
  McpToolOutputContract<never>,
  "handlerDataType"
>;

export type ToolScope = (typeof MCP_ALL_RESOURCE_SCOPES)[number];

/**
 * Closed set of reasons a tool is kept off the anonymized surface. No
 * freetext: adding a tool forces one of these, and the projection in
 * `static-tool-definitions.ts` can only reason about known reasons.
 */
const MCP_ANONYMIZED_EXCLUSION_REASONS = [
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
  /**
   * Read tool whose output describes natural persons found in an external
   * register: names, birth dates, identifiers and addresses. Dates and
   * identifiers are not text the redactor can anonymize, so the tool fails
   * closed and is excluded from the anonymized surface.
   */
  "personal_register_data",
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
const MCP_TOOL_ACCESS_LEVELS = ["read", "write"] as const;

export type McpToolAccess = (typeof MCP_TOOL_ACCESS_LEVELS)[number];

export type McpToolAnnotations = NonNullable<McpTool["annotations"]> & {
  destructiveHint: boolean;
  openWorldHint: boolean;
  title: string;
};

export type McpReadClass = "tenant" | "public" | "both";

export type McpReadClassResolver = (
  args: unknown,
) => McpReadClass | undefined | Promise<McpReadClass | undefined>;

/** Reads declare their source; the generic gateway resolves its target instead. */
export const resolveMcpReadClass = async (
  definition: McpToolDefinition,
  args: unknown,
) =>
  typeof definition.readClass === "function"
    ? definition.readClass(args)
    : definition.readClass;

/**
 * `access` and `readOnlyHint` are one fact stated twice (the registry's
 * structural signal and the MCP client hint), so the type binds them: a
 * `read` tool must carry `readOnlyHint: true` and a `write` tool must carry
 * `readOnlyHint: false`. The other behavioral hints are required too, so a
 * definition cannot rely on protocol defaults that submission reviewers and
 * clients may interpret differently.
 */
export type McpToolAccessBranch =
  | {
      access: "read";
      readClass: McpReadClass | McpReadClassResolver;
      annotations: McpToolAnnotations & { readOnlyHint: true };
    }
  | {
      access: "write";
      /** Generic dispatch may invoke a read target despite its own write access. */
      readClass?: McpReadClassResolver;
      annotations: McpToolAnnotations & { readOnlyHint: false };
      /**
       * The member authority every call needs; discovery and dispatch enforce
       * it centrally through `write-tool-authority.ts`.
       */
      permissions: McpWriteToolPermissions;
      /**
       * Whether the configured demo account may use the tool, declared as its
       * REST counterpart declares it (`standard` refuses it, `sandbox`
       * admits it); discovery and dispatch read it through the same owner.
       */
      accountAccess: AccountAccess;
    };

export type McpToolDestructiveBehavior =
  | { type: "always" }
  | {
      type: "input-discriminator";
      property: string;
      destructiveValues: readonly string[];
    }
  | { type: "capability-catalog" }
  | { type: "upstream" };

/**
 * A call that sends workspace-authored content outside the workspace. It
 * destroys nothing, so `destructiveHint` stays false and clients must not
 * render it as a deletion, but it is irreversible in the sense that matters to
 * a human: the content is gone from their control once it lands. The transport
 * gate treats it exactly like a destructive call and refuses without
 * `confirm: true`; `reason` is what the refusal tells the model it is about to
 * do.
 */
type McpToolOutboundBehavior = { type: "outbound"; reason: string };

/** Every behavior the transport confirmation gate reads. */
type McpToolConfirmationBehavior =
  | McpToolDestructiveBehavior
  | McpToolOutboundBehavior;

type McpToolDestructiveBranch =
  | {
      annotations: McpToolAnnotations & { destructiveHint: false };
      destructiveBehavior?: undefined;
      /** Why a broader update grant does not imply this handler modifies data. */
      nonDestructiveReason?: string;
    }
  | {
      annotations: McpToolAnnotations & { destructiveHint: false };
      nonDestructiveReason?: never;
      destructiveBehavior: Extract<
        McpToolConfirmationBehavior,
        { type: "outbound" }
      >;
    }
  | {
      annotations: McpToolAnnotations & { destructiveHint: true };
      // Updating existing data needs the client hint even when the server
      // requires no irreversible-action confirmation.
      destructiveBehavior?: McpToolDestructiveBehavior;
      nonDestructiveReason?: never;
    };

export type McpToolDefinition = McpToolAccessBranch &
  McpToolDestructiveBranch & {
    /**
     * Host-extension metadata served verbatim through `tools/list`. Keep it on
     * the canonical definition so MCP Apps and host-specific transports cannot
     * grow a second registry beside the in-app chat and CLI projections.
     */
    _meta?: McpTool["_meta"];
    /**
     * Extra grants required in addition to the primary `scope`. Discovery and
     * dispatch both enforce this list centrally, so compound operations cannot
     * be advertised or called with only one half of their consent contract.
     */
    additionalScopes?: readonly ToolScope[];
    anonymized: McpAnonymizedPolicy;
    consumesServices: boolean;
    description: string;
    /**
     * Deployment feature flag gating this tool. When set, the tool is dropped
     * from the advertised list and its dispatch is rejected unless
     * `isDeploymentFeatureEnabled` holds for it. Omitted for always-available
     * tools.
     */
    feature?: DeploymentFeatureFlag;
    featureId?: FeatureId;
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
  destructive?: boolean;
  include?: readonly string[];
  required?: readonly string[];
};

export type McpCliToolAnnotation = {
  feature?: DeploymentFeatureFlag;
  featureId?: FeatureId;
  command: readonly string[];
  additionalScopes?: readonly McpCliToolScope[];
  /** API-owned finite transport deadline projected into generated CLI leaves. */
  requestTimeoutMs?: number;
  excluded?: true;
  scope?: McpCliToolScope;
  itemsKey?: string;
  singleReadWhen?: string;
  columns?: readonly string[];
  /**
   * The tool answers one window of long text, paged by `cursor`. `textPath`
   * is where that text lives in the payload, dot-separated
   * (`text`, `decision.text`, `statute.text`): a CLI that assumed a top-level
   * `text` rendered nothing for a read that nests its subject, so the path is
   * stated rather than defaulted.
   */
  windowedText?: { textPath: string };
  paginationless?: true;
  /**
   * The leaf takes a `--cursor` but does not offer `--all`. A per-entry cursor
   * is the case this exists for: the payload carries one continuation per
   * item, so there is no single page for the follow loop to advance, and a
   * loop that followed a top-level cursor would stop after one window and
   * return truncated content as if it were whole.
   */
  perEntryCursor?: true;
  inputOnly?: readonly string[];
  discriminator?: {
    prop: string;
    subcommands: Record<string, McpCliDiscriminatorSubcommand>;
  };
  flagRename?: Record<string, string>;
  /**
   * The input prop that carries a document as base64. A host fills the tool's
   * `file` reference from its own transport; a CLI caller has no host, so the
   * generated command grows `--file <path>` and fills THIS prop from the local
   * bytes. It adds no tool input: the wire call is the one an MCP host could
   * make. The prop must declare a `maxLength`, which becomes the CLI's stated
   * and enforced ceiling.
   */
  localFileBase64Prop?: string;
  /**
   * The tool is not destructive itself but gates SOME calls behind its `confirm`
   * arg (per-target destructiveness, e.g. `invoke_capability` where the invoked
   * capability's catalog flag decides). The CLI leaf then accepts `--yes`
   * (injecting `confirm: true` upfront) and, on a `confirmation_required`
   * envelope at a TTY, prompts and retries once with `confirm: true`.
   */
  confirmPassthrough?: true;
  /**
   * The result is one record that holds tables (a check answering per list),
   * so neither a single row list nor a key/value dump shows all of it. Table
   * output prints `summary` as key/value lines, then each section as a table;
   * JSON and JSONL output print the payload as is. A payload with no array at
   * the first section's rows (another outcome of the same tool) renders as a
   * single record.
   */
  composite?: McpCliCompositeView;
};

/** One table of a composite result. */
type McpCliCompositeSection = {
  /** The heading printed above the table. */
  title: string;
  /**
   * Dot path to an array of records. A segment ending in `[]` spreads an
   * array, so `lists[].possibleMatches` gathers every list's matches into one
   * table.
   */
  rows: string;
  /**
   * Dot paths read from each row. A path starting with `^.` reads the record
   * the row was gathered from, so a gathered match can name its list.
   */
  columns: readonly string[];
};

type McpCliCompositeView = {
  /** Dot paths printed as key/value lines above the tables; absent and null values are skipped. */
  summary: readonly string[];
  sections: readonly [McpCliCompositeSection, ...McpCliCompositeSection[]];
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
 * Compat search hit before egress. The `kind` is the anonymization
 * disposition, not a display label: a `matter` hit carries tenant-authored
 * text and the `workspaceId` the egress pipeline groups its redaction by, and
 * a `corpus` hit is published law that every reader may see as written. Both
 * fields are stripped before the result reaches the client.
 */
export type McpCompatSearchResult =
  | {
      kind: "matter";
      id: string;
      title: string;
      url: string;
      workspaceId: string;
    }
  | {
      kind: "corpus";
      id: string;
      title: string;
      url: string;
      source_url?: string;
    };

/**
 * What one compat fetch is reading, and therefore whether its text is
 * anonymizable tenant content or published law. The same discriminator is the
 * `metadata.kind` the client receives, so the egress decision and the answer
 * the model reads cannot disagree; `workspaceId` exists only on the branch
 * that has one.
 */
export type McpCompatFetchSubject =
  | { kind: "document"; workspaceId: string }
  | { kind: "decision" }
  | { kind: "statute" };

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
 * A successful Stella tool result is its data and nothing else. The MCP
 * boundary serializes `data` into `structuredContent` and its JSON text
 * fallback, and a host shows the model one or the other. There is no prose
 * side channel: guidance the caller needs (the next call, an onboarding step)
 * is a typed `nextStep` field of the tool's output contract.
 */
export type InternalToolSuccess<TData = unknown> = {
  status: "success";
  data: TData;
};

export type InternalToolStructuredError = {
  type: "structured";
  message: string;
  hint?: string;
  issues?: readonly McpValidationIssue[];
  retryable?: boolean;
  contactUrl?: string;
  requestId?: string;
} & (
  | { code: "internal_error"; readonly [MCP_INTERNAL_TOOL_FAILURE]: true }
  | { code: Exclude<McpErrorCode, "internal_error"> }
);

export type InternalToolTextError = {
  type: "text";
  message: string;
};

export type InternalToolError =
  | InternalToolStructuredError
  | InternalToolTextError;

export type InternalToolErrorResult = {
  status: "error";
  error: InternalToolError;
};

/**
 * Canonical result returned by Stella-owned tool execution. It contains domain
 * data or a typed error, never an MCP content block. The MCP boundary converts
 * this result to `CallToolResult`; internal consumers use it directly.
 */
export type InternalToolResult<TData = unknown> =
  | InternalToolSuccess<TData>
  | InternalToolErrorResult;

/**
 * A handler either returns a finished internal result, or an egress plan the
 * dispatch layer finalizes (anonymize declared text fields, then window).
 * Egress plans keep the full, pre-window, un-anonymized payload so
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
export type McpEgressPlan<TPayload = unknown> =
  | {
      egress: "compatSearch";
      paginationOutcome?: SearchPaginationOutcome;
      nextCursor: string | null | undefined;
      results: readonly McpCompatSearchResult[];
    }
  | {
      egress: "compatFetch";
      source_url?: string;
      cursor: string | undefined;
      id: string;
      maxChars: number;
      subject: McpCompatFetchSubject;
      text: string;
      title: string;
      url: string;
    }
  | {
      egress: "structured";
      payload: TPayload;
      textFields: readonly McpStructuredTextField[];
      /** Clear structured personal fields that text anonymization cannot rewrite. */
      redactInAnonymized?: () => void;
      window?: McpStructuredWindow;
    };

export type McpToolResponse<TData = unknown> =
  | InternalToolResult<TData>
  | McpEgressPlan<TData>;

export type TypedMcpToolResponse<TData> =
  | InternalToolResult<TData>
  | Extract<McpEgressPlan<TData>, { egress: "structured" }>;

export const isMcpEgressPlan = (
  response: McpToolResponse,
): response is McpEgressPlan => "egress" in response;

export type McpToolHandler<TData = unknown> = ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}) => McpToolResponse<TData> | Promise<McpToolResponse<TData>>;

type TypedMcpToolHandlerResult<TData> =
  | TypedMcpToolResponse<TData>
  | Promise<TypedMcpToolResponse<TData>>;

export type TypedMcpToolHandler<TData> = (options: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}) => TypedMcpToolHandlerResult<TData>;

type TypedHandlerData<THandler> =
  THandler extends McpToolHandler<infer TData> ? TData : never;

type IsAny<TValue> = 0 extends 1 & TValue ? true : false;

type IsNever<TValue> = [TValue] extends [never] ? true : false;

type IsUnknown<TValue> =
  IsAny<TValue> extends true ? false : unknown extends TValue ? true : false;

type IsBroadRecord<TValue> = string extends keyof TValue ? true : false;

export type TypedHandlerDataByName<
  THandlers,
  TNames extends keyof THandlers,
> = {
  [TName in TNames]: TypedHandlerData<THandlers[TName]>;
};

type HandlerOutputIsTyped<THandler, TData = TypedHandlerData<THandler>> =
  IsNever<TData> extends true
    ? false
    : IsAny<TData> extends true
      ? false
      : IsUnknown<TData> extends true
        ? false
        : IsBroadRecord<TData> extends true
          ? false
          : TData extends Record<string, unknown>
            ? true
            : false;

type HandlerOutputMatches<THandler, TExpected> =
  HandlerOutputIsTyped<THandler> extends true
    ? [TypedHandlerData<THandler>] extends [TExpected]
      ? [TExpected] extends [TypedHandlerData<THandler>]
        ? true
        : false
      : false
    : false;

export type AllHandlerOutputsTyped<
  THandlers,
  TNames extends keyof THandlers,
> = false extends {
  [TName in TNames]: HandlerOutputIsTyped<THandlers[TName]>;
}[TNames]
  ? false
  : true;

export type HandlerOutputsMatchByName<
  THandlers,
  TExpectedByName,
  TNames extends keyof THandlers & keyof TExpectedByName,
> = false extends {
  [TName in TNames]: HandlerOutputMatches<
    THandlers[TName],
    TExpectedByName[TName]
  >;
}[TNames]
  ? false
  : true;

export type AssertTrue<TValue extends true> = TValue;

export type McpToolHandlerMap<
  TDefinitions extends readonly McpToolDefinition[],
> = Readonly<Record<TDefinitions[number]["name"], McpToolHandler>>;

export type McpToolOutputContractMap<
  TDefinitions extends readonly McpToolDefinition[],
> = Readonly<
  Record<TDefinitions[number]["name"], McpToolOutputContract<never>>
>;

type OutputContractData<TContract> =
  TContract extends McpToolOutputContract<infer TData> ? TData : never;

type IdentityOutputNames<TOutputs> = {
  [TName in keyof TOutputs]: TOutputs[TName] extends {
    projection: "identity";
  }
    ? TName
    : never;
}[keyof TOutputs];

type OutputDataByName<TOutputs> = {
  [TName in keyof TOutputs]: OutputContractData<TOutputs[TName]>;
};

type OutputContractAssertion<THandlers, TOutputs> =
  IdentityOutputNames<TOutputs> extends infer TNames extends keyof THandlers &
    keyof TOutputs
    ? [TNames] extends [never]
      ? unknown
      : AllHandlerOutputsTyped<THandlers, TNames> extends true
        ? HandlerOutputsMatchByName<
            THandlers,
            OutputDataByName<TOutputs>,
            TNames
          > extends true
          ? unknown
          : never
        : never
    : never;

type OutputBoundHandlerMap<
  TDefinitions extends readonly McpToolDefinition[],
  TOutputs extends McpToolOutputContractMap<TDefinitions>,
> = {
  readonly [TName in TDefinitions[number]["name"]]: McpToolHandler<
    OutputContractData<TOutputs[TName]>
  >;
};

export type McpToolSet<
  TDefinitions extends readonly McpToolDefinition[],
  TOutputs extends McpToolOutputContractMap<TDefinitions> =
    McpToolOutputContractMap<TDefinitions>,
> = {
  readonly definitions: TDefinitions;
  readonly handlers: McpToolHandlerMap<TDefinitions>;
  readonly outputs: TOutputs;
};

/**
 * Binds advertised tool definitions to their dispatch handlers in one typed
 * value. Adding, removing, or renaming a static tool now forces the handler map
 * to change in the same module; the central registry derives both surfaces from
 * these sets instead of maintaining a second name list.
 */
export const defineMcpToolSet = <
  const TDefinitions extends readonly McpToolDefinition[],
  const TOutputs extends McpToolOutputContractMap<TDefinitions>,
  const THandlers extends OutputBoundHandlerMap<TDefinitions, TOutputs>,
>(
  definitions: TDefinitions,
  handlers: THandlers &
    Record<Exclude<keyof THandlers, TDefinitions[number]["name"]>, never> &
    OutputContractAssertion<THandlers, TOutputs>,
  outputs: TOutputs &
    Record<Exclude<keyof TOutputs, TDefinitions[number]["name"]>, never>,
): McpToolSet<TDefinitions, TOutputs> => ({ definitions, handlers, outputs });

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
