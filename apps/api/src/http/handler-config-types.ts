import type { ModelTask } from "@stll/ai-catalog";
import type { PermissionInput } from "@stll/permissions";

import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import type { AnySchema, RouteConfig } from "@/api/http/route";
import type { WorkspaceStatusAccess } from "@/api/lib/auth/accessible-workspace";
import type { AccountAccess } from "@/api/lib/auth/account-access";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { CapabilityTransport } from "@/api/lib/capability-transport";
import type { ContentDelivery } from "@/api/lib/files/content-delivery";
import type { PeriodActionKind } from "@/api/lib/rate-limit/action-kinds";
import type { ServiceClassification } from "@/api/lib/rate-limit/service-classification";
import type { ResourceSetRealtime } from "@/api/lib/resource-set-realtime";
import type { WriteContract } from "@/api/lib/write-contract/write-contract";
import type { McpReadClass } from "@/api/mcp/constants";
// Type-only: keep endpoint metadata independent of the expensive MCP schema graph.
import type { McpToolName } from "@/api/mcp/static-tool-names";

/**
 * The closed set of curated static MCP tool names. Every `type: "tool"` and
 * `type: "covered"` disposition references one of these; the coverage guard
 * (`apps/api/scripts/mcp-coverage-guard.ts`) cross-checks the runtime registry.
 */
export type { McpToolName };

/**
 * Reasons an endpoint is a real end-to-end capability a user or their agent
 * would legitimately automate (CRUD on their data/config, triggering/retrying
 * processing, exports) but is deliberately *not* a curated static MCP tool: the
 * curated tool list is capped for the agent context budget, so the long tail is
 * reached through the generic capability path instead. A `capability`
 * disposition still lands in the exported capability catalog; only `internal`
 * (below) is fully waived. Closed union (no freetext): a new capability
 * category is a deliberate, reviewed addition here.
 *
 * - `template_authoring_ui`: Template Studio authoring endpoints (create/save/
 *   version templates, categories, clause slots) beyond the curated template
 *   tools.
 * - `workspace_schema`: table/view/property/document-type configuration and
 *   metadata operations that shape a workspace.
 * - `knowledge_library_admin`: clause/playbook authoring, versioning, import/
 *   export, and review operations beyond the curated knowledge tools.
 * - `agent_tool_authoring`: skill/catalogue CRUD used to author tools; enabled
 *   skills are also exposed through the dynamic MCP gateway.
 * - `anonymization_admin`: anonymization term/allowlist configuration.
 * - `legal_corpus_admin`: corpus ingestion, linking, and analysis operations
 *   beyond the public legal-search tool contract.
 * - `workflow_orchestration`: workflow queue/run/progress operations.
 * - `reporting_export`: report and table export generation/readback.
 * - `contact_directory`: organization contact directory list/search.
 * - `billing_admin`: billing/invoice/expense/rate-card/time-entry CRUD and
 *   invoice generation (checkout and payment-provider plumbing stays
 *   `internal` under `hosted_billing`).
 * - `document_processing`: document upload/download/version/translate/duplicate/
 *   restore/compare and processing triggers. UI-only viewer/facet/grouping
 *   reads and bounding-box generation stay `internal` under the same reason.
 * - `assistant_chat`: chat thread CRUD (list/read/update/delete threads and
 *   their messages). Chat generation/streaming runtime and per-surface thread
 *   plumbing stay `internal` under the same reason.
 * - `chat_thread_ui`: chat-thread rename. Breadcrumb title lookup stays
 *   `internal` under the same reason.
 * - `file_transport`: the presigned-upload loop (create/update/delete). These
 *   are the ONLY file-input path an agent surface has: the generic JSON invoke
 *   cannot carry a `File`, so the multipart endpoints stay unreachable and
 *   clients drive presign -> PUT -> finalize instead. Bulk tree/preflight
 *   helpers stay `internal` under `upload_mechanics`.
 * - `contact_extraction_ui`: AI-assisted contact intake from an uploaded
 *   source document (e.g. a procuração); review-before-create only, not a
 *   standing agent capability. Mirrors `template_authoring_ui`.
 * - `correspondence`: matter correspondence list, read, and handling changes.
 * - `personal_history`: the caller's own search history (list, delete one,
 *   clear). Recording a use and the one-time browser import stay `internal`
 *   under `search_ui`.
 * - `assistant_memory`: the assistant memory the caller may read and write
 *   (list, create, update). Firm-wide memory writes stay `internal` under
 *   `assistant_chat`.
 * - `notification_inbox`: the caller's own notifications (list, mark one
 *   read). Mark-all and announcements stay `internal` under `native_tool_ui`.
 * - `cross_matter_search`: the search screen's results across the matters the
 *   caller can open, by text, result type, editor, file type and date. The
 *   curated `search` and `search_across_matters` tools are separate, narrower
 *   knowledge searches; facets, preview and the AI helpers stay `internal`
 *   under `search_ui`.
 */
type McpCapabilityReason =
  | "template_authoring_ui"
  | "workspace_schema"
  | "knowledge_library_admin"
  | "agent_tool_authoring"
  | "anonymization_admin"
  | "legal_corpus_admin"
  | "workflow_orchestration"
  | "reporting_export"
  | "contact_directory"
  | "billing_admin"
  | "document_processing"
  | "assistant_chat"
  | "chat_thread_ui"
  | "file_transport"
  | "contact_extraction_ui"
  | "correspondence"
  | "personal_history"
  | "assistant_memory"
  | "notification_inbox"
  | "organization_management"
  | "organization_admin"
  | "cross_matter_search";

/**
 * Approved, permanent reasons an endpoint is intentionally never reachable from
 * an agent surface at all: transport/plumbing/UI mechanics and the approved
 * permanent exclusions. Unlike `McpCapabilityReason`, these stay out of the
 * capability catalog entirely. Closed union (no freetext): a new waiver category
 * is a deliberate, reviewed addition here.
 *
 * - `auth_plumbing`: better-auth / sign-in / verification / session routes.
 * - `upload_mechanics`: bulk entity-create tree and preflight upload steps.
 *   The single-file presign / finalize / abort loop is a `capability` under
 *   `file_transport`.
 * - `realtime_stream`: SSE / event-stream endpoints.
 * - `session_token_exchange`: folio-collab and desktop-edit token/session
 *   exchange handlers that authorize themselves from a body/param token.
 * - `webhook`: inbound webhooks from external providers.
 * - `dev_only`: routes mounted only in development.
 * - `account_lifecycle`: account deletion / lifecycle flows.
 * - `hosted_billing`: hosted-billing checkout / setup / management plumbing.
 * - `mcp_transport`: the MCP transport / connector routes themselves.
 * - `health_infra`: health, smoke, and operator observability endpoints.
 * - `chat_thread_ui`: chat-thread UI chrome reads (breadcrumb title lookup);
 *   the rename operation is a `capability` under the same reason.
 * - `provider_secret`: writes/probes of provider API keys and secrets (AI
 *   provider config, DeepL key, web-search key, provider validation). Secret
 *   material must never transit an agent surface; these stay dashboard-only.
 * - `deploy_mechanics`: deployment/availability mechanics for native tools
 *   (which backends can be deployed), an operator concern, not an agent action.
 * - `ui_navigation_state`: per-user UI navigation state (active workspace,
 *   navigation tree) that only makes sense for the interactive web client.
 * - `assistant_chat`: chat generation/streaming runtime and per-surface thread
 *   plumbing (suggested prompts, recaps, template/file thread resolution). The
 *   thread-CRUD operations are `capability` under the same reason.
 * - `url_preview`: server-side external-URL unfurl/preview mechanics.
 * - `public_indexing`: public listing, facet, and sitemap endpoints used for
 *   SEO/UI discovery; agents use the curated public search/read tools instead.
 * - `search_ui`: search refinement/facet/summary affordances for the web UI and
 *   in-app chat; MCP clients use `search` / `search_across_matters`.
 * - `document_processing`: UI-only viewer/facet/grouping reads and bounding-box
 *   generation; the real document operations are `capability` under the same
 *   reason.
 * - `native_tool_ui`: native-tool helper endpoints whose agent surface is a
 *   chat/native integration rather than the static MCP registry.
 * - `billing_ui`: billing UI helpers that transform draft input without
 *   reading or persisting ledger records; agents use the billing capabilities.
 * - `compound_consent`: operations that require multiple independent OAuth
 *   consent families; these stay first-party-only until the generic capability
 *   path can enforce conjunctive scopes.
 * - `human_confirmation`: the user's own confirmation of an action an agent
 *   prepared (for example sending an email they reviewed); an agent must never
 *   be able to confirm for them.
 * - `organization_export`: starting or downloading a whole-organization data
 *   export; a person performs it in the app, never an agent, because it hands
 *   over the firm's privileged material in one action.
 * - `native_device`: a native app registering the device it runs on (push
 *   alert delivery). Only the signed-in app holds the device token; an agent
 *   that could register one could route a person's alerts elsewhere.
 * - `agent_autonomy_ceiling`: an organization's limit on how much an agent
 *   may do without asking. An agent that could change it could raise its
 *   own limit, so only an administrator in the app sets it.
 */
type McpInternalReason =
  | "auth_plumbing"
  | "upload_mechanics"
  | "realtime_stream"
  | "session_token_exchange"
  | "webhook"
  | "dev_only"
  | "account_lifecycle"
  | "hosted_billing"
  | "mcp_transport"
  | "health_infra"
  | "chat_thread_ui"
  | "provider_secret"
  | "deploy_mechanics"
  | "ui_navigation_state"
  | "assistant_chat"
  | "url_preview"
  | "public_indexing"
  | "search_ui"
  | "document_processing"
  | "native_tool_ui"
  | "billing_ui"
  | "compound_consent"
  | "human_confirmation"
  | "native_device"
  | "organization_export"
  | "agent_autonomy_ceiling";

/**
 * Required per-handler MCP disposition. Making this a field on every handler
 * config (like `permissions`) means a new backend capability cannot be added
 * without a typecheck-enforced decision about how agents reach it via MCP.
 *
 * - `tool`: this endpoint is the backing implementation of tool `name`.
 * - `covered`: the capability is reachable through tool `by`, via a different
 *   code path (e.g. a shared handler the tool re-uses).
 * - `capability`: a real end-to-end operation a user or their agent legitimately
 *   automates (CRUD on their data/config, triggering/retrying processing,
 *   exports), deliberately not a curated static MCP tool because the tool list
 *   is capped for the agent context budget. Reached through the generic
 *   capability path and included in the exported capability catalog; `reason` is
 *   an approved, closed-union category.
 * - `internal`: intentionally never reachable from an agent surface; `reason` is
 *   an approved, closed-union permanent waiver (transport/plumbing/UI mechanics
 *   and the approved permanent exclusions).
 */
export type McpExposure =
  | { type: "tool"; name: McpToolName; readClass?: McpReadClass }
  | { type: "covered"; by: McpToolName; readClass?: McpReadClass }
  | {
      type: "capability";
      reason: McpCapabilityReason;
      /** Curated wrapper that delegates to this capability. */
      by?: McpToolName;
      consumesServices: ServiceClassification;
      confirmation?: "required";
      readClass?: McpReadClass;
    }
  | { type: "internal"; reason: McpInternalReason };

/**
 * Per-handler usage metering opt-in. When set, the framework:
 *  - runs `assertUsageAvailable` pre-flight with a fixed
 *    action-cost estimate (only when `USAGE_ENFORCEMENT_ENABLED=true`;
 *    otherwise the check is a no-op so observation-mode runs
 *    always pass through).
 *
 * Post-flight ledger writes happen from model step callbacks,
 * where the actual model usage is available. Keeping writes out
 * of the generic handler layer prevents fixed-estimate rows and
 * usage-based rows from double-counting the same action.
 *
 * `serviceTier` defaults to "standard" — that's the user-clicked
 * "Run now" path. Queue-mode handlers pass `"flex"` (or `"batch"`
 * for cron-driven enrichment).
 */
export type UsageMeteringConfig = {
  actionType: UsageActionType;
  serviceTier?: UsageServiceTier;
  /**
   * Opt this endpoint's pre-flight into per-user budget-lane routing.
   * Only the interactive chat send declares it; pricing an action as
   * "chat" is not by itself evidence the handler can honor a lane.
   */
  laneRouting?: true;
  /**
   * Logical model task recorded on the consumption ledger row.
   * Defaults to `"chat"`. Set to the task the handler will pass
   * to the model resolver so cross-cutting analytics match
   * the actual model.
   */
  modelTask?: ModelTask;
};

/**
 * One prose description of what a capability does, written for the agent that
 * will decide whether to call it. This is the SINGLE place the description
 * lives: the capability-catalog exporter carries it into both committed catalog
 * mirrors, from which the CLI derives `--help` for the generated command and MCP
 * derives `list_capabilities` / `describe_capability` output. Do not duplicate
 * it into a hand-written MCP tool definition.
 *
 * Write it the way a tool description is written, not the way a code comment is:
 * lead with the operation, then the consequential detail a caller needs BEFORE
 * invoking (irreversibility, what else it deletes, which fields are required for
 * a create vs. an update, what `null` clears). Per-PROPERTY prose does not
 * belong here; it goes on the property's own schema
 * (`v.pipe(v.string(), v.description("..."))`), which the same exporter carries
 * into the catalog's `inputSchema`.
 *
 * Optional in the type, required by
 * apps/api/scripts/capability-description-guard.ts, which fails a capability
 * without one.
 */
export type CapabilityDescription = {
  description?: string;
};

/**
 * Explicit read/write nature of a capability, for the MCP/CLI consent scope it
 * resolves to. This is a DECLARATION, not an inference: a handler's `permissions`
 * gate answers "who may call this" (a caller access level), which is a separate
 * axis from whether the handler reads or writes — the same `workspace:["read"]`
 * gate legitimately fronts a pure list and a cache-filling write. Only the
 * author knows which. A capability that would resolve to a read scope must carry
 * `access: "read"` to affirm it is a pure read; anything that mutates (a DB
 * write, an AI generation kickoff, a job enqueue) must declare `access: "write"`
 * so a read-only consent cannot reach it. The exporter fails if an inferred read
 * lacks this affirmation. Omit it only when the capability resolves to a write
 * by inference — over-classifying a write is safe (it just requires write
 * consent), so writes need no affirmation.
 */
export type CapabilityAccess =
  | { access?: "write" }
  | {
      access: "read";
      mcp:
        | Exclude<McpExposure, { type: "capability" }>
        | (Extract<McpExposure, { type: "capability" }> & {
            readClass: McpReadClass;
          });
    };

/**
 * How this capability's payload crosses the generic JSON transport (see
 * `lib/capability-transport.ts`). Omitting it declares `{ type: "json" }`: the
 * ordinary case, where body/params/query go in as JSON and a structured value
 * comes back.
 *
 * A handler whose schema declares a file field (`fileSchema`), or whose
 * success path returns a `Response`/raw bytes, MUST declare the matching file
 * transport. That is not a convention anyone has to remember: the
 * `require-file-transport-disposition` lint rule flags the schema side at author
 * time, and the capability exporter re-derives BOTH legs from the live schema
 * and the handler source and fails on any disagreement with what is declared
 * here — a missing declaration, a declaration naming a field that is not binary,
 * a stale `required` after an optionality flip, or a file transport on a handler
 * that no longer returns bytes. So the default can never silently absorb a file
 * capability, and the declaration can never drift away from the handler.
 */
export type CapabilityTransportDisposition = {
  transport?: CapabilityTransport;
};

export type ContentDeliveryDisposition = {
  contentDelivery?: ContentDelivery;
};

/** The request and response schemas a handler config declares. */
export type InputSchema = RouteConfig;

export type HandlerConfig = InputSchema &
  WriteContract &
  CapabilityDescription &
  ContentDeliveryDisposition &
  CapabilityAccess &
  CapabilityTransportDisposition & {
    /** Money-only response schema; the common egress checks it on every transport. */
    moneyResponse?: AnySchema;
    permissions: PermissionInput;
    accountAccess: AccountAccess;
    /** Finite API-owned transport deadline for a generated capability command. */
    requestTimeoutMs?: number;
    /** Scoped DB mutations only; external side effects require owner-specific receipt integration. */
    idempotency?: { type: "replay" };
    requiresUsage?: UsageMeteringConfig;
    featureAccess?: FeatureAccessRequirement;
    /** Finite synchronous work; streaming and queued execution need their own lifetimes. */
    actionAdmission?: { type: "handler"; actionKind: PeriodActionKind };
    /**
     * Resource sets a successful call announces to open tabs. The wrapper
     * broadcasts them for every transport (REST, capability executors, CLI);
     * see `lib/resource-set-realtime.ts`.
     */
    realtime?: ResourceSetRealtime;
    mcp: McpExposure;
  };

/**
 * Config for a workspace-scoped route, one `createSafeHandler` mounts under a
 * `:workspaceId` prefix. The matter must be active unless the config admits
 * archived ones too (unarchiving does).
 */
export type WorkspaceHandlerConfig = HandlerConfig & {
  workspaceStatus?: WorkspaceStatusAccess;
};

export type HandlerConfigurationAdmission =
  "allowed" | "permission_required" | "account_restricted";
