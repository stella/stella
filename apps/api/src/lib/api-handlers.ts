import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Err } from "better-result";
import { panic, Result, UnhandledException } from "better-result";
import * as v from "valibot";

import type { ModelTask } from "@stll/ai-catalog";
import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import type { PermissionInput } from "@stll/permissions";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import { env } from "@/api/env";
import type { RouteCachePolicy } from "@/api/http/cache";
import type { ResponseSet } from "@/api/http/context";
import { decodeRequestInput } from "@/api/http/input";
import type { QueryRecord } from "@/api/http/input";
import type {
  AnySchema,
  RouteAccess,
  RouteConfig,
  RouteRequest,
} from "@/api/http/route";
import { decodeRouteInput, routeContext } from "@/api/http/route-input";
import type { RawParams, RouteContext } from "@/api/http/route-input";
import { HttpStatusResponse, status } from "@/api/http/status";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  memberAssignmentRequiredError,
  orgAIConfigStatusError,
} from "@/api/lib/ai-config-response";
import { captureObservedError } from "@/api/lib/analytics/capture";
import {
  authenticateMember,
  authenticateSession,
  authorizeWorkspace,
} from "@/api/lib/auth";
import type { WorkspaceStatusAccess } from "@/api/lib/auth";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import type { AccountAccess } from "@/api/lib/auth/account-access";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type {
  MemberCaller,
  WorkspaceCaller,
} from "@/api/lib/auth/member-caller";
import { checkRestrictedAccountOperation } from "@/api/lib/auth/review-account";
import type { SafeId } from "@/api/lib/branded-types";
import type { CapabilityTransport } from "@/api/lib/capability-transport";
import { workspaceSegmentSchema } from "@/api/lib/custom-schema";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import type { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { ProviderCallError } from "@/api/lib/errors/provider-call-error";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type {
  HandlerErrorClaim,
  HandlerErrorCode,
  HandlerErrorConfirmationDetail,
  HandlerErrorMissingRequiredField,
  HandlerErrorStatusCode,
  HandlerErrorValidationIssue,
} from "@/api/lib/errors/tagged-errors";
import { errorTag, unredactedErrorFields } from "@/api/lib/errors/utils";
import {
  isFeatureAccessSnapshotForPrincipal,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessProof } from "@/api/lib/feature-access/policy";
import {
  getContentDeliveryReceiptError,
  markContentDeliveryIntent,
  runWithContentDeliveryScope,
} from "@/api/lib/files/content-delivery";
import type { ContentDelivery } from "@/api/lib/files/content-delivery";
import {
  fingerprintHttpRequest,
  runWithRequestReceipt,
} from "@/api/lib/idempotency/request-receipts";
import {
  publicReadTimeoutError,
  runPublicReadRequest,
} from "@/api/lib/legal-search/public-read-timeout";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import {
  causeChainAttributes,
  failureSink,
  identityFields,
  requestErrorStatusFields,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  legacyChannelOf,
  observeShadow,
  SHADOW_SINKS,
  shadowFields,
} from "@/api/lib/observability/failure-shadow";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  getRequestContext,
  recordRequestExceptionScope,
} from "@/api/lib/observability/request-context";
import {
  hasMemberPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  authorizeOperation,
  cloneOperationInput,
} from "@/api/lib/proofs/checked-transaction";
import type { CheckedOperationContext } from "@/api/lib/proofs/checked-transaction";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { PeriodActionKind } from "@/api/lib/rate-limit/action-kinds";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import type { ServiceClassification } from "@/api/lib/rate-limit/service-classification";
import {
  announceResourceSetUpdates,
  isSuccessfulHandlerResult,
  type NoResourceSetUpdates,
  type OrganizationResourceSetUpdates,
  type ResourceSetRealtime,
} from "@/api/lib/resource-set-realtime";
import {
  projectPublicErrorBody,
  PUBLIC_ERROR_TEXT_BYTES,
  safePublicHandlerErrorOrStatusTextResponseSchema,
} from "@/api/lib/search/public-error-response";
import { truncateTextBytes } from "@/api/lib/search/response-text-bounds";
import {
  getTanStackTextModelInfoForTask,
  resolveEffectiveServiceTierForProvider,
  resolveFallbackChatSelection,
} from "@/api/lib/tanstack-ai-models";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
import { decideChatUsageLane } from "@/api/lib/usage/lane-routing";
import type { UsageLaneDecision } from "@/api/lib/usage/lane-routing";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { assertUsageAvailable } from "@/api/lib/usage/usage-ledger";
import { recordWriteContract } from "@/api/lib/write-contract/write-contract";
import type { WriteContract } from "@/api/lib/write-contract/write-contract";
// Type-only: keep endpoint metadata independent of the expensive MCP schema graph.
import type { McpToolName } from "@/api/mcp/static-tool-names";
import type { McpReadClass } from "@/api/mcp/tool-types";
import { isLocalDevOpen } from "@/api/runtime-mode";

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
  | "notification_inbox";

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
  | "compound_consent";

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
 * Optional only until the remaining gaps are closed. Every capability without
 * one is listed by id in `apps/api/capability-description-ledger.json`; a new
 * capability may not join that list, and authoring prose means deleting its
 * line in the same change (see apps/api/scripts/capability-description-guard.ts).
 */
type CapabilityDescription = {
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
type CapabilityAccess =
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
type CapabilityTransportDisposition = {
  transport?: CapabilityTransport;
};

type ContentDeliveryDisposition = {
  contentDelivery?: ContentDelivery;
};

/** The request and response schemas a handler config declares. */
type InputSchema = RouteConfig;

export type HandlerConfig = InputSchema &
  WriteContract &
  CapabilityDescription &
  ContentDeliveryDisposition &
  CapabilityAccess &
  CapabilityTransportDisposition & {
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

/**
 * Which restricted accounts may call a handler. Every handler config declares
 * one: `sandbox` admits every account, `standard` refuses the demo account,
 * and `account-control` (credentials, keys, billing, external connections,
 * organization configuration) also refuses the restricted review account.
 */
export { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
export type { AccountAccess } from "@/api/lib/auth/account-access";

const requiresAccountCheck = (accountAccess: AccountAccess) =>
  accountAccess !== ACCOUNT_ACCESS.sandbox;

export type HandlerConfigurationAdmission =
  "allowed" | "permission_required" | "account_restricted";

/**
 * Projects the permission and restricted-account checks performed by safe
 * handlers without running the handler. Capability endpoints use this to
 * advertise the same admission decision as the operation they describe.
 */
export const checkHandlerConfigurationAdmission = ({
  principal,
  config,
  checkAccountOperation = checkRestrictedAccountOperation,
}: {
  // The email is read only when an account check applies: a sandbox handler's
  // context need not carry a user.
  principal: { memberRole: AuthorizedMemberRole; readEmail: () => string };
  config: Pick<HandlerConfig, "permissions" | "accountAccess">;
  checkAccountOperation?: typeof checkRestrictedAccountOperation;
}): HandlerConfigurationAdmission => {
  if (!hasMemberPermission(principal.memberRole, config.permissions)) {
    return "permission_required";
  }
  if (
    requiresAccountCheck(config.accountAccess) &&
    Result.isError(
      checkAccountOperation(principal.readEmail(), config.accountAccess),
    )
  ) {
    return "account_restricted";
  }
  return "allowed";
};

/**
 * Factories without an organization-scoped caller run no account check, so
 * their handlers admit the demo account and can only declare `sandbox`.
 */
type SandboxAccountAccess = {
  accountAccess: typeof ACCOUNT_ACCESS.sandbox;
};

/**
 * Handlers the safe factories produced, with the account access their config
 * declares. A route census reads it: a mounted handler missing here skipped
 * every factory, so it carries no account decision of its own.
 */
const safeHandlerAccountAccess = new WeakMap<
  object,
  { accountAccess: AccountAccess; permissions?: PermissionInput }
>();

const recordSafeHandler = <
  TDefinition extends {
    config: WriteContract & {
      accountAccess: AccountAccess;
      permissions?: PermissionInput;
      body?: unknown;
      description?: string;
    };
    access: RouteAccess;
    handler: object;
  },
>(
  definition: TDefinition,
): TDefinition => {
  recordWriteContract(definition.handler, definition.config);
  safeHandlerAccountAccess.set(definition.handler, definition.config);
  return definition;
};

export const getSafeHandlerAccountAccess = (handler: unknown) =>
  typeof handler === "function"
    ? safeHandlerAccountAccess.get(handler)?.accountAccess
    : undefined;

export const getSafeHandlerAccessMetadata = (handler: unknown) =>
  typeof handler === "function"
    ? safeHandlerAccountAccess.get(handler)
    : undefined;

export type SessionHandlerConfig = InputSchema &
  WriteContract &
  CapabilityDescription &
  ContentDeliveryDisposition &
  CapabilityAccess &
  CapabilityTransportDisposition & {
    accountAccess: AccountAccess;
    mcp: McpExposure;
  };

type SessionHandlerContext<
  TConfig extends SessionHandlerConfig = SessionHandlerConfig,
> = RouteContext<TConfig> & {
  user: {
    id: SafeId<"user">;
    email: string;
  };
};

type BaseHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  RouteContext<TConfig> &
    MemberCaller & {
      /** Set by the route's feature-access decision; `undefined` once it found none. */
      featureAccessProof?: FeatureAccessProof | undefined;
      /**
       * Budget lane the usage pre-flight resolved for this request.
       * Set only when the handler declares `requiresUsage` and
       * enforcement is on; handlers thread it into their metering so
       * consumption settles against the decided budget.
       */
      usageLane?: UsageLaneDecision;
      /** Shared lease and client cancellation, set only for admitted finite work. */
      actionSignal?: AbortSignal;
      /** Proof a model dispatch needs; set only for admitted finite work. */
      modelAdmission?: ModelDispatchAdmission;
    };

type RootHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig>;

type WorkspaceHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig> & WorkspaceCaller;

type SafeHandlerError =
  | ActionAdmissionError
  | DatabaseError
  | DatabaseRlsError
  | HandlerError
  | UnhandledException;

type SafeErrorBody = {
  providerDiagnostic?: ProviderDiagnostic;
  code?: HandlerErrorCode;
  message: string;
  /** Corrective next step for programmatic clients. */
  hint?: string;
  clause?: HandlerError["clause"];
  contactUrl?: string;
  retryable?: boolean;
  /** Advised wait before retrying, in milliseconds. */
  retryAfterMs?: number;
  /** Field-scoped reasons the request was rejected. */
  issues?: HandlerErrorValidationIssue[];
  /**
   * Structured fields surfaced on specific error responses. Today
   * only the 402 UsageLimitExceeded path uses them so the
   * frontend can render an "x of y units left" modal without
   * parsing the human-readable message. Optional everywhere so
   * other handlers don't have to populate them.
   */
  reason?: string;
  required?: number;
  available?: number;
  /**
   * Structured 409 detail when a queued run's estimated consumption
   * needs an explicit go-ahead (see HandlerErrorConfirmationDetail).
   */
  confirmation?: HandlerErrorConfirmationDetail;
  /**
   * OAuth-style machine-readable error identifier surfaced on the
   * agent-auth ID-JAG path (e.g. `login_required`,
   * `interaction_required`, `issuer_not_enabled`). Optional everywhere.
   */
  error?: string;
  /**
   * Step-up ceremony fields on an ID-JAG `interaction_required`. Per the
   * pinned guide `claim` carries ceremony fields only; the registration
   * handles below ride at the top level (spread from the error's `stepUp`),
   * mirroring the `service_auth` registration envelope. Optional everywhere.
   */
  claim?: HandlerErrorClaim;
  registration_id?: string;
  registration_type?: string;
  claim_url?: string;
  claim_token?: string;
  claim_token_expires?: string;
  post_claim_scopes?: string[];
  /** Every required field a rejected fill was missing, in full (see
   *  HandlerErrorMissingRequiredField). Optional everywhere. */
  requiredFields?: HandlerErrorMissingRequiredField[];
};

const safeHandlerErrorResponseSchema = v.looseObject({
  message: v.string(),
  code: v.optional(v.string()),
});

const safeHandlerErrorOrStatusTextResponseSchema = v.union([
  safeHandlerErrorResponseSchema,
  v.string(),
]);

type SafeHandlerErrorResponseSchemas<TErrorSchema extends AnySchema> = Readonly<
  Record<HandlerErrorStatusCode, TErrorSchema>
>;

const safeHandlerErrorResponseSchemas = <TErrorSchema extends AnySchema>(
  errorSchema: TErrorSchema,
): SafeHandlerErrorResponseSchemas<TErrorSchema> => ({
  400: errorSchema,
  401: errorSchema,
  402: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  413: errorSchema,
  422: errorSchema,
  426: errorSchema,
  428: errorSchema,
  429: errorSchema,
  500: errorSchema,
  502: errorSchema,
  503: errorSchema,
});

const SAFE_HANDLER_ERROR_RESPONSE_SCHEMAS = safeHandlerErrorResponseSchemas(
  safeHandlerErrorResponseSchema,
);

type SafeHandlerResponseSchemasFor<
  TSuccessSchema extends AnySchema,
  TErrorSchema extends AnySchema,
> = {
  readonly [TStatus in 200 | HandlerErrorStatusCode]: TStatus extends 200
    ? TSuccessSchema
    : TErrorSchema;
};

export type SafeHandlerResponseSchemas<TSuccessSchema extends AnySchema> =
  SafeHandlerResponseSchemasFor<
    TSuccessSchema,
    typeof safeHandlerErrorResponseSchema
  >;

export const safeHandlerResponseSchemas = <TSuccessSchema extends AnySchema>(
  successSchema: TSuccessSchema,
): SafeHandlerResponseSchemas<TSuccessSchema> => ({
  200: successSchema,
  ...SAFE_HANDLER_ERROR_RESPONSE_SCHEMAS,
});

type SafeHandlerStatusTextResponseSchemas<TSuccessSchema extends AnySchema> =
  SafeHandlerResponseSchemasFor<
    TSuccessSchema,
    typeof safeHandlerErrorOrStatusTextResponseSchema
  >;

const SAFE_HANDLER_STATUS_TEXT_RESPONSE_SCHEMAS =
  safeHandlerErrorResponseSchemas(safeHandlerErrorOrStatusTextResponseSchema);

export const safeHandlerResponseSchemasWithStatusText = <
  TSuccessSchema extends AnySchema,
>(
  successSchema: TSuccessSchema,
): SafeHandlerStatusTextResponseSchemas<TSuccessSchema> => ({
  200: successSchema,
  ...SAFE_HANDLER_STATUS_TEXT_RESPONSE_SCHEMAS,
});

const SAFE_PUBLIC_HANDLER_STATUS_TEXT_RESPONSE_SCHEMAS =
  safeHandlerErrorResponseSchemas(
    safePublicHandlerErrorOrStatusTextResponseSchema,
  );

export const safePublicHandlerResponseSchemasWithStatusText = <
  TSuccessSchema extends AnySchema,
>(
  successSchema: TSuccessSchema,
): SafeHandlerResponseSchemasFor<
  TSuccessSchema,
  typeof safePublicHandlerErrorOrStatusTextResponseSchema
> => ({
  200: successSchema,
  ...SAFE_PUBLIC_HANDLER_STATUS_TEXT_RESPONSE_SCHEMAS,
});

// The conditional form keeps status unions distributive, so each error code
// stays a distinct answer instead of one widened response.
type SafeStatusResponse<TStatusCode extends HandlerErrorStatusCode> =
  TStatusCode extends HandlerErrorStatusCode
    ? HttpStatusResponse<TStatusCode, SafeErrorBody>
    : never;

/**
 * Success payloads are objects, arrays or other non-nullish values, so every
 * answer is a JSON document a client can extend without breaking. Model
 * absence as a field (`{ entitlement: null }`, `{ items: [] }`); void
 * mutations return a minimal object such as `{}`.
 */
type SafeHandlerPayload = NonNullable<unknown>;

type SafeHandlerResult<TResult> =
  TResult | SafeStatusResponse<HandlerErrorStatusCode>;

/**
 * The async-generator a safe handler runs: it may `yield*` intermediate
 * `Result.await(...)` failures (the `Err` yield) and finally returns a
 * `Result<TResult, …>`.
 *
 * Annotate an *extracted* handler generator with this whenever its result must
 * reach the client typed. TypeScript cannot infer an async generator's return
 * type across `yield*` delegation, so a handler written as
 * `createSafeRootHandler(cfg, (ctx) => yield* myHandler(ctx))` silently widens
 * `TResult` (and the API client's response type) to `unknown` unless
 * `myHandler` is
 * declared `: SafeHandlerGenerator<MyResult>`.
 */
export type SafeHandlerGenerator<TResult> = AsyncGenerator<
  Err<never, SafeHandlerError>,
  Result<TResult, SafeHandlerError>,
  unknown
>;

type SafeHandlerFn<TContext, TResult extends SafeHandlerPayload> = (
  ctx: TContext,
) => SafeHandlerGenerator<TResult>;

/** A safe handler before it is bound to the HTTP transport. */
type SafeHandlerCore<
  TConfig extends InputSchema,
  TContext,
  TResult extends SafeHandlerPayload,
> = {
  readonly config: TConfig;
  /** Who may call the route; the factory decides it, never the mount site. */
  readonly access: RouteAccess;
  /** The handler with its checks, for transports that build the context themselves. */
  readonly handler: (ctx: TContext) => Promise<SafeHandlerResult<TResult>>;
};

type SafeHandlerDefinition<
  TConfig extends InputSchema = InputSchema,
  TContext = RouteContext<TConfig>,
  TResult extends SafeHandlerPayload = SafeHandlerPayload,
> = SafeHandlerCore<TConfig, TContext, TResult> & {
  /** The route over HTTP: caller, input, then the handler. */
  readonly run: (request: RouteRequest) => Promise<unknown>;
};

/** Org routes: a member of the active organization, then the input. */
const memberRun =
  <TConfig extends HandlerConfig>(
    config: TConfig,
    handler: (ctx: RootHandlerContext<TConfig>) => Promise<unknown>,
  ) =>
  async (request: RouteRequest): Promise<unknown> => {
    const member = await authenticateMember(request.ctx, config);
    if (!member.ok) {
      return member.answer;
    }
    const input = await decodeRouteInput(
      config,
      request,
      await request.readBody(),
    );
    return await handler({ ...routeContext(request, input), ...member.caller });
  };

/**
 * Matter routes: a member, then the matter the path names, then the input. A
 * caller without the matter is refused before its input is read.
 */
const workspaceRun =
  <TConfig extends WorkspaceHandlerConfig>(
    config: TConfig,
    handler: (ctx: WorkspaceHandlerContext<TConfig>) => Promise<unknown>,
  ) =>
  async (request: RouteRequest): Promise<unknown> => {
    const member = await authenticateMember(request.ctx, config);
    if (!member.ok) {
      return member.answer;
    }
    const { workspaceId } = await decodeRequestInput(
      workspaceSegmentSchema,
      request.ctx.params,
    );
    const matter = await authorizeWorkspace(
      member.caller,
      request.ctx,
      workspaceId,
      config.workspaceStatus ?? "active",
    );
    if (!matter.ok) {
      return matter.answer;
    }
    const input = await decodeRouteInput(
      config,
      request,
      await request.readBody(),
    );
    return await handler({
      ...routeContext(request, input),
      ...member.caller,
      ...matter.caller,
    });
  };

const hasWorkspaceId = <TContext extends object>(
  ctx: TContext,
): ctx is TContext & { workspaceId: SafeId<"workspace"> } =>
  "workspaceId" in ctx;

const API_ERROR_CODE = {
  accessDenied: "access_denied",
  forbidden: "forbidden",
  internalServerError: "internal_server_error",
  usageLimitExceeded: "usage_limit_exceeded",
  usageConfirmationRequired: "usage_confirmation_required",
} as const satisfies Record<string, HandlerErrorCode>;

// This needs function overloads. A generic arrow returning `status(statusCode)`
// widens too much, and the casted version trips oxlint's unsafe assertion rule.
function toSafeStatusResponse<TStatusCode extends HandlerErrorStatusCode>(
  statusCode: TStatusCode,
  body: SafeErrorBody,
): SafeStatusResponse<TStatusCode>;
function toSafeStatusResponse(
  statusCode: HandlerErrorStatusCode,
  body: SafeErrorBody,
) {
  return status(statusCode, body);
}

export type SafeHandlerLogContext = {
  request: Request;
  route: string;
  set?: ResponseSet;
};

const withSafeHandlerExceptionScope = <TResult>(
  ctx: SafeHandlerLogContext,
  operation: () => TResult,
): TResult => {
  const scope = ctx.route.startsWith("mcp:invoke_capability/")
    ? ({ type: "handler", handlerId: ctx.route } as const)
    : ({
        type: "request",
        method: ctx.request.method,
        routeTemplate: ctx.route,
      } as const);
  recordRequestExceptionScope(ctx.request, scope);
  return withExceptionScope(scope, operation);
};

type ErrorStatusBuilder<TErrorStatus> = (
  statusCode: HandlerErrorStatusCode,
  body: SafeErrorBody,
) => TErrorStatus;

type RunSafeHandlerWithOptions<
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
  TErrorStatus,
> = {
  ctx: TContext;
  handler: SafeHandlerFn<TContext, TResult>;
  /** Builds the response for every handled failure; owns the error wire shape. */
  toErrorStatus: ErrorStatusBuilder<TErrorStatus>;
};

const getResponseHeader = (
  headers: ResponseSet["headers"],
  name: string,
): unknown =>
  Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())
    ?.at(1);

const applyRetryAfterHeader = (
  ctx: SafeHandlerLogContext,
  retryAfterMs: number | undefined,
) => {
  if (retryAfterMs === undefined || ctx.set === undefined) {
    return;
  }
  ctx.set.headers["Retry-After"] = String(
    Math.max(1, Math.ceil((retryAfterMs * (1 + Math.random() * 0.5)) / 1000)),
  );
};

const runSafeHandlerInDeliveryScope = async <
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
  TErrorStatus,
>({
  ctx,
  handler,
  toErrorStatus,
}: RunSafeHandlerWithOptions<TContext, TResult, TErrorStatus>): Promise<
  TResult | TErrorStatus
> => {
  try {
    const result = await Result.gen(() => handler(ctx));

    if (Result.isOk(result)) {
      const response = result.value;
      const disposition = ctx.set
        ? getResponseHeader(ctx.set.headers, "Content-Disposition")
        : undefined;
      if (
        (response instanceof Response &&
          response.ok &&
          response.body !== null) ||
        response instanceof ArrayBuffer ||
        ArrayBuffer.isView(response) ||
        response instanceof Blob ||
        response instanceof ReadableStream ||
        (disposition !== undefined && disposition !== null)
      ) {
        markContentDeliveryIntent();
      }
      const deliveryError = getContentDeliveryReceiptError();
      if (deliveryError) {
        throw deliveryError;
      }
      return result.value;
    }

    const error = result.error;

    const handlerError =
      publicReadTimeoutError(error) ??
      resolveHandlerError(error, env.ACTION_LIMIT_CONTACT_URL);
    if (handlerError !== null) {
      const statusCode = handlerError.status;

      applyRetryAfterHeader(ctx, handlerError.retryAfterMs);

      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error: handlerError,
        statusCode,
        telemetry: safeErrorTelemetryDisposition(statusCode, handlerError.code),
      });

      return toErrorStatus(statusCode, safeErrorBody(handlerError));
    }

    if (DatabaseError.is(error)) {
      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 500,
        telemetry: "capture",
      });

      return toErrorStatus(500, {
        code: API_ERROR_CODE.internalServerError,
        message: "Internal server error",
      });
    }

    if (DatabaseRlsError.is(error)) {
      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 400,
        // A denial is answered as a client outcome but reported as a fault:
        // RLS is the last isolation guard, so a request that reaches it is a
        // defect in the query above it.
        telemetry: "capture",
      });

      return toErrorStatus(400, {
        code: API_ERROR_CODE.accessDenied,
        message: "Access denied",
      });
    }

    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error,
      statusCode: 500,
      telemetry: "capture",
    });

    return toErrorStatus(500, {
      code: API_ERROR_CODE.internalServerError,
      message: "Internal server error",
    });
  } catch (error) {
    // A typed HandlerError thrown synchronously (or escaping the
    // Result.gen pipeline) must still surface as its own status,
    // not a generic 500. Without this branch a deeper handler
    // that throws HandlerError for a recoverable condition (e.g.
    // an AI request hitting a role the org has not configured a
    // BYOK key for) gets reported to the user as "Internal
    // server error" with no actionable detail.
    const handlerError =
      publicReadTimeoutError(error) ??
      resolveHandlerError(error, env.ACTION_LIMIT_CONTACT_URL);
    if (handlerError !== null) {
      applyRetryAfterHeader(ctx, handlerError.retryAfterMs);
      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error: handlerError,
        statusCode: handlerError.status,
        telemetry: safeErrorTelemetryDisposition(
          handlerError.status,
          handlerError.code,
        ),
      });
      return toErrorStatus(handlerError.status, safeErrorBody(handlerError));
    }

    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error,
      statusCode: 500,
      telemetry: "capture",
    });

    return toErrorStatus(500, {
      code: API_ERROR_CODE.internalServerError,
      message: "Internal server error",
    });
  }
};

const runSafeHandlerWith = async <
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
  TErrorStatus,
>({
  contentDelivery,
  ...options
}: RunSafeHandlerWithOptions<TContext, TResult, TErrorStatus> & {
  contentDelivery: ContentDelivery | undefined;
}): Promise<TResult | TErrorStatus> =>
  await runWithContentDeliveryScope(
    contentDelivery,
    async () => await runSafeHandlerInDeliveryScope(options),
  );

type RunSafeHandlerOptions<
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
> = {
  ctx: TContext;
  handler: SafeHandlerFn<TContext, TResult>;
  contentDelivery: ContentDelivery | undefined;
};

const runSafeHandler = async <
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
>({
  ctx,
  handler,
  contentDelivery,
}: RunSafeHandlerOptions<TContext, TResult>): Promise<
  SafeHandlerResult<TResult>
> =>
  await runSafeHandlerWith({
    ctx,
    handler,
    contentDelivery,
    toErrorStatus: toSafeStatusResponse,
  });

type FiniteHandlerGuard<TResult> = [Extract<TResult, Response>] extends [never]
  ? unknown
  : never;

type NonJsonReplayPayload<T> =
  T extends HttpStatusResponse<infer _Code, infer Body>
    ? NonJsonReplayPayload<Body>
    : Extract<
        T,
        Response | ReadableStream | Blob | ArrayBuffer | ArrayBufferView
      >;

type ConfiguredFiniteHandlerGuard<TConfig, TResult> = (TConfig extends {
  idempotency: { type: "replay" };
}
  ? NoInfer<[NonJsonReplayPayload<TResult>] extends [never] ? unknown : never>
  : unknown) &
  (TConfig extends {
    actionAdmission: { type: "handler"; actionKind: PeriodActionKind };
  }
    ? NoInfer<FiniteHandlerGuard<TResult>>
    : unknown);

type FiniteActionContext = SafeHandlerLogContext & {
  user: { id: SafeId<"user"> };
  session: { activeOrganizationId: SafeId<"organization"> };
  scopedDb: ScopedDb;
  actionSignal?: AbortSignal;
  modelAdmission?: ModelDispatchAdmission;
};

/** What admitted finite work runs with: its lease signal and model proof. */
type AdmittedFiniteContext = {
  actionSignal: AbortSignal;
  modelAdmission: ModelDispatchAdmission;
};

type FiniteActionOptions<TContext, TResult extends SafeHandlerPayload> = {
  actionKind: PeriodActionKind;
  ctx: TContext;
  handler: SafeHandlerFn<TContext & AdmittedFiniteContext, TResult>;
  admit?: typeof withActionAdmission;
};

const runAdmittedFiniteHandler = async function* <
  TContext extends FiniteActionContext,
  TResult extends SafeHandlerPayload,
>({
  ctx,
  handler,
  actionKind,
  admit = withActionAdmission,
}: FiniteActionOptions<TContext, TResult>): SafeHandlerGenerator<TResult> {
  return yield* Result.await(
    admit({
      organizationId: ctx.session.activeOrganizationId,
      userId: ctx.user.id,
      organizationStateDb: ctx.scopedDb,
      periodIdentity: {
        actionKind,
        // These finite endpoints have no client idempotency key.
        logicalPhaseId: getRequestContext()?.requestId ?? Bun.randomUUIDv7(),
      },
      run: async (signal) => {
        // Check before composing signals: composition can drop the request's
        // reason. Keep a typed refusal's status; any other disconnect is a 400.
        if (ctx.request.signal.aborted) {
          // The DOM types the reason as any; read it as unknown and narrow.
          const reason: unknown = ctx.request.signal.reason;
          return Result.err(
            reason instanceof HandlerError
              ? reason
              : new HandlerError({
                  status: 400,
                  message: "Request aborted",
                  cause: reason,
                }),
          );
        }
        const dispatch = await admitModelDispatch({
          organizationId: ctx.session.activeOrganizationId,
          userId: ctx.user.id,
          actionKind,
          organizationStateDb: ctx.scopedDb,
          signal,
          run: async (modelAdmission) => {
            const admitted = Object.assign(ctx, {
              actionSignal: AbortSignal.any([ctx.request.signal, signal]),
              modelAdmission,
            });
            admitted.actionSignal.throwIfAborted();
            return await Result.gen(() => handler(admitted));
          },
        });
        const outcome = Result.isError(dispatch)
          ? Result.err(dispatch.error)
          : dispatch.value;
        if (Result.isOk(outcome) && outcome.value instanceof Response) {
          // Cancel the producer too: a rejected stream must not keep running after release.
          await outcome.value.body?.cancel();
          return Result.err(
            new HandlerError({
              status: 500,
              code: API_ERROR_CODE.internalServerError,
              message: "Internal server error",
              cause: new UnhandledException({
                cause: "Finite handlers cannot return a Response",
              }),
            }),
          );
        }
        return outcome;
      },
    }).then((admitted) =>
      Result.mapError(admitted, (error) => {
        const handlerError = resolveHandlerError(
          error,
          env.ACTION_LIMIT_CONTACT_URL,
        );
        if (handlerError !== null) {
          return handlerError;
        }
        if (DatabaseError.is(error) || DatabaseRlsError.is(error)) {
          return error;
        }
        return new UnhandledException({ cause: error });
      }),
    ),
  );
};

/**
 * The model proof of a handler whose config declares `actionAdmission`: the
 * wrapper admits the request and sets it before the handler runs. The
 * dispatch-admission guard checks that every caller declares the admission.
 */
export const configuredModelAdmission = ({
  modelAdmission,
}: {
  modelAdmission?: ModelDispatchAdmission | undefined;
}): ModelDispatchAdmission =>
  modelAdmission ??
  panic("A handler dispatched a model without its configured admission");

/**
 * Call after resource authorization and the operation's usage preflight.
 * @yields Typed failures for the owning safe-handler boundary.
 */
export const admitFiniteAction = async function* <
  TContext extends FiniteActionContext,
  TResult extends SafeHandlerPayload,
>({
  ctx,
  handler,
  admit,
  actionKind,
}: FiniteActionOptions<TContext, TResult> & {
  handler: SafeHandlerFn<TContext & AdmittedFiniteContext, TResult> &
    NoInfer<FiniteHandlerGuard<TResult>>;
}): SafeHandlerGenerator<TResult> {
  return yield* runAdmittedFiniteHandler({
    actionKind,
    ctx,
    handler,
    ...(admit === undefined ? {} : { admit }),
  });
};

type HandlerAdmissionDependencies = {
  admit?: typeof withActionAdmission;
  checkAccountOperation?: typeof checkRestrictedAccountOperation;
  announce?: typeof announceResourceSetUpdates;
};

const REALTIME_ANNOUNCEMENT_FAILURE = failureSink({
  event: "resource-set-realtime.announce",
  expected: [],
});

const HANDLER_USAGE_ALLOWED = "HandlerUsageAllowed";

type ScopedOperationInput<
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult extends SafeHandlerPayload,
> = {
  ctx: TContext;
  config: TConfig;
  handler: SafeHandlerFn<TContext, TResult>;
  admit: typeof withActionAdmission;
};

export const runCheckedScopedHandler = async <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult extends SafeHandlerPayload,
  N,
>(
  {
    proof,
    scratch,
  }: CheckedOperationContext<
    typeof HANDLER_USAGE_ALLOWED,
    ScopedOperationInput<TConfig, TContext, TResult>,
    N
  >,
  usageLane?: UsageLaneDecision,
  /** The live request's response state; the proof's copy by default. */
  responseSet: ResponseSet = scratch.ctx.set,
): Promise<SafeHandlerResult<TResult>> => {
  const { ctx, config, handler, admit } = cloneOperationInput(
    proof.input.value,
  );
  const admission = config.actionAdmission;
  const run = async (handlerContext: TContext) =>
    await runSafeHandler({
      ctx: {
        ...handlerContext,
        // Response state belongs to the live request, outside the proof copy.
        set: responseSet,
        ...(usageLane === undefined ? {} : { usageLane }),
      },
      contentDelivery: config.contentDelivery,
      handler:
        admission === undefined
          ? handler
          : (context) =>
              runAdmittedFiniteHandler({
                ctx: context,
                handler,
                admit,
                actionKind: admission.actionKind,
              }),
    });
  const request = ctx.request;
  const key = request.headers.get("Idempotency-Key");
  if (key === null) {
    return await run(ctx);
  }
  if (config.idempotency === undefined) {
    return await runSafeHandler({
      ctx: { ...ctx, set: responseSet },
      contentDelivery: undefined,
      async *handler() {
        return yield* Result.await(
          Promise.resolve(
            Result.err(
              new HandlerError({
                status: 400,
                message:
                  "This endpoint does not support Idempotency-Key. Omit the header and use its documented submission flow.",
              }),
            ),
          ),
        );
      },
    });
  }
  return await runSafeHandler({
    ctx: { ...ctx, set: responseSet },
    contentDelivery: undefined,
    async *handler() {
      const result = yield* Result.await(
        Result.tryPromise(
          async () =>
            await runWithRequestReceipt({
              scopedDb: ctx.scopedDb,
              organizationId: ctx.session.activeOrganizationId,
              userId: ctx.user.id,
              key,
              route: ctx.route,
              fingerprint: await fingerprintHttpRequest({
                method: request.method,
                route: ctx.route,
                body: ctx.body,
                params: ctx.params,
                query: ctx.query,
              }),
              run: async (scopedDb) =>
                await run({
                  ...ctx,
                  scopedDb,
                  safeDb: safeDbFromScoped(scopedDb),
                }),
              responseStatus: () => responseSet.status ?? 200,
            }),
        ),
      );
      return result;
    },
  });
};

type HandlerFeatureAccessOptions<
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
> = {
  ctx: TContext;
  config: TConfig;
};

/**
 * Decide the route's feature access. Admitted, the handler runs with the
 * context this decision produced (the snapshot it read and, for an enabled
 * feature, the proof a model dispatch needs); refused, the answer is final.
 */
const admitHandlerFeatureAccess = async <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
>({
  ctx: requestCtx,
  config,
}: HandlerFeatureAccessOptions<TConfig, TContext>) => {
  let featureAccess = config.featureAccess;
  // A proof is only ever this decision's: none carries over from elsewhere.
  let ctx: TContext =
    featureAccess === undefined
      ? requestCtx
      : { ...requestCtx, featureAccessProof: undefined };
  const fail = async (failure: SafeHandlerError) => ({
    answer: await runSafeHandler({
      ctx,
      contentDelivery: config.contentDelivery,
      async *handler(): SafeHandlerGenerator<never> {
        return yield* Result.await(Promise.resolve(Result.err(failure)));
      },
    }),
  });
  if (
    featureAccess?.type === "conditional" &&
    featureAccess.decision === "when-used" &&
    (ctx.featureAccessSnapshot === undefined ||
      !isFeatureAccessSnapshotForPrincipal(ctx.featureAccessSnapshot, {
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
      }))
  ) {
    const conditionalFeatureAccess = featureAccess;
    const usage = await Result.tryPromise(
      async () =>
        await conditionalFeatureAccess.usesFeature({
          body: ctx.body,
          params: ctx.params,
          query: ctx.query,
          organizationId: ctx.session.activeOrganizationId,
          userId: ctx.user.id,
          scopedDb: ctx.scopedDb,
          safeDb: ctx.safeDb,
          ...(hasWorkspaceId(ctx) ? { workspaceId: ctx.workspaceId } : {}),
        }),
    );
    if (usage.isErr()) {
      return await fail(usage.error);
    }
    if (!usage.value) {
      featureAccess = undefined;
    }
  }
  if (featureAccess !== undefined) {
    const principal = {
      organizationId: ctx.session.activeOrganizationId,
      userId: ctx.user.id,
    };
    const snapshot =
      ctx.featureAccessSnapshot === undefined ||
      !isFeatureAccessSnapshotForPrincipal(ctx.featureAccessSnapshot, principal)
        ? await ctx.safeDb(
            async (tx) =>
              await resolveFeatureAccessSnapshot({
                tx,
                organizationId: ctx.session.activeOrganizationId,
                userId: ctx.user.id,
              }),
          )
        : Result.ok(ctx.featureAccessSnapshot);
    if (Result.isError(snapshot)) {
      return await fail(snapshot.error);
    }
    const enabled = isFeatureEnabled(
      snapshot.value,
      featureAccess.featureId,
      principal,
    );
    const decision = snapshot.value.decisions.get(featureAccess.featureId);
    ctx = {
      ...ctx,
      featureAccessSnapshot: snapshot.value,
      featureAccessProof:
        enabled && decision?.status === "enabled" ? decision.proof : undefined,
    };
    if (!enabled) {
      const usage =
        featureAccess.type === "required"
          ? Result.ok(true)
          : await Result.tryPromise(
              async () =>
                await featureAccess.usesFeature({
                  body: ctx.body,
                  params: ctx.params,
                  query: ctx.query,
                  organizationId: ctx.session.activeOrganizationId,
                  userId: ctx.user.id,
                  scopedDb: ctx.scopedDb,
                  safeDb: ctx.safeDb,
                  ...(hasWorkspaceId(ctx)
                    ? { workspaceId: ctx.workspaceId }
                    : {}),
                }),
            );
      if (Result.isError(usage)) {
        return await fail(usage.error);
      }
      if (usage.value) {
        return { answer: toSafeStatusResponse(404, { message: "Not found" }) };
      }
    }
  }
  return { ctx };
};

const createSafeScopedHandler = <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult extends SafeHandlerPayload,
>(
  access: "member" | "workspace",
  config: TConfig,
  handler: SafeHandlerFn<TContext, TResult>,
  {
    admit = withActionAdmission,
    checkAccountOperation = checkRestrictedAccountOperation,
    announce = announceResourceSetUpdates,
  }: HandlerAdmissionDependencies = {},
): SafeHandlerCore<TConfig, TContext, TResult> =>
  recordSafeHandler({
    config,
    access,
    handler: async (requestCtx): Promise<SafeHandlerResult<TResult>> =>
      await withSafeHandlerExceptionScope(requestCtx, async () => {
        const memberRole = readAuthorizedMemberRole(requestCtx);
        if (!memberRole) {
          return toSafeStatusResponse(403, {
            code: API_ERROR_CODE.forbidden,
            message: "Forbidden",
          });
        }
        const configurationAdmission = checkHandlerConfigurationAdmission({
          principal: { memberRole, readEmail: () => requestCtx.user.email },
          config,
          checkAccountOperation,
        });
        if (configurationAdmission === "permission_required") {
          return toSafeStatusResponse(403, {
            code: API_ERROR_CODE.forbidden,
            message: "Forbidden",
          });
        }
        if (configurationAdmission === "account_restricted") {
          return toSafeStatusResponse(403, {
            code: "account_access_unavailable",
            message: "This operation is unavailable for this account.",
          });
        }
        const featureAccess = await admitHandlerFeatureAccess({
          ctx: requestCtx,
          config,
        });
        if ("answer" in featureAccess) {
          return featureAccess.answer;
        }
        const { ctx } = featureAccess;

        const visible = await Result.tryPromise(
          async () =>
            await resourcesAreVisible({
              inputs: [
                { schema: config.body, value: ctx.body },
                { schema: config.params, value: ctx.params },
                { schema: config.query, value: ctx.query },
              ],
              scopedDb: async (read) => {
                const result = await ctx.safeDb(read);
                if (result.isErr()) {
                  throw result.error;
                }
                return result.value;
              },
            }),
        );
        if (visible.isErr()) {
          return await runSafeHandler({
            ctx,
            contentDelivery: config.contentDelivery,
            async *handler() {
              return yield* Result.await(
                Promise.resolve(Result.err(visible.error)),
              );
            },
          });
        }
        if (!visible.value) {
          return toSafeStatusResponse(404, { message: "Not found" });
        }

        let usageLane = ctx.usageLane;
        const authorization = await authorizeOperation({
          kind: HANDLER_USAGE_ALLOWED,
          input: { ctx, config, handler, admit },
          check: async ({
            ctx: checkedContext,
            config: checkedConfig,
          }): Promise<Result<void, HandlerError>> => {
            const configStatusError = checkedConfig.requiresUsage
              ? orgAIConfigStatusError(checkedContext.orgAIConfigStatus)
              : null;
            if (configStatusError) {
              return Result.err(configStatusError);
            }
            if (checkedConfig.requiresUsage && env.USAGE_ENFORCEMENT_ENABLED) {
              const meteringContext = resolveMeteringContext({
                metering: checkedConfig.requiresUsage,
                organizationId: checkedContext.session.activeOrganizationId,
                orgAIConfig: checkedContext.orgAIConfig,
                workspaceId: hasWorkspaceId(checkedContext)
                  ? checkedContext.workspaceId
                  : null,
                userId: checkedContext.user.id,
              });
              const preflight = await runUsagePreflight({
                ctx: checkedContext,
                meteringContext,
              });
              if (Result.isError(preflight)) {
                return Result.err(preflight.error);
              }
              usageLane = preflight.value;
            }
            return Result.ok(undefined);
          },
        });
        if (Result.isError(authorization)) {
          return toSafeStatusResponse(
            authorization.error.status,
            safeErrorBody(authorization.error),
          );
        }
        const result = await authorization.value.execute(
          async (operation) =>
            // Response state belongs to the request; handler data belongs to this execution.
            await runCheckedScopedHandler(operation, usageLane, ctx.set),
        );
        // The transaction has settled; realtime delivery cannot change its result.
        if (
          config.realtime !== undefined &&
          config.realtime.scope !== "none" &&
          isSuccessfulHandlerResult(result)
        ) {
          const announcement = Result.try(() =>
            announce({
              realtime: config.realtime,
              result,
              organizationId: ctx.session.activeOrganizationId,
              workspaceId: hasWorkspaceId(ctx) ? ctx.workspaceId : undefined,
            }),
          );
          if (Result.isError(announcement)) {
            observeFailure(announcement.error, {
              sink: REALTIME_ANNOUNCEMENT_FAILURE,
            });
          }
        }
        return result;
      }),
  });

type ResolvedMeteringContext = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  actionType: UsageActionType;
  serviceTier: UsageServiceTier;
  isByok: boolean;
  laneRouting: boolean;
  cost: number;
};

export const resolveMeteringContext = ({
  metering,
  organizationId,
  orgAIConfig,
  workspaceId,
  userId,
}: {
  metering: UsageMeteringConfig;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
}): ResolvedMeteringContext => {
  const modelTask = metering.modelTask ?? "chat";
  const modelInfo = getTanStackTextModelInfoForTask(modelTask, orgAIConfig, {
    dataClass: "customer",
    organizationId,
    // Unit metering and the free tier never run together
    // (`freeTierInvariantViolation`), so a metered organization is standard.
    modelTier: MANAGED_MODEL_TIER.standard,
  });
  const isByok = modelInfo.keySource === "byok";
  const serviceTier = resolveEffectiveServiceTierForProvider({
    provider: modelInfo.provider,
    region: modelInfo.region,
    serviceTier: metering.serviceTier ?? "standard",
  });
  const cost = computeUsageUnitCost({
    actionType: metering.actionType,
    serviceTier,
    isByok,
  });
  return {
    organizationId,
    workspaceId,
    userId,
    actionType: metering.actionType,
    serviceTier,
    isByok,
    laneRouting: metering.laneRouting === true,
    cost,
  };
};

type PreflightCtx = {
  request: Request;
  route: string;
  safeDb: SafeDb;
};

const runUsagePreflight = async ({
  ctx,
  meteringContext,
}: {
  ctx: PreflightCtx;
  meteringContext: ResolvedMeteringContext;
}): Promise<Result<UsageLaneDecision, HandlerError<402 | 403 | 500>>> => {
  if (meteringContext.cost <= 0) {
    // BYOK (and other zero-cost) turns never draw a managed budget.
    return Result.ok({ lane: "pool" });
  }
  const checkResult = await ctx.safeDb(async (tx) => {
    // Only endpoints that opted into lane routing (the interactive
    // chat send) resolve a per-user budget lane; a turn inside the
    // included budget settles there and skips the pool check
    // entirely. A fallback verdict must also be servable on this
    // deployment, otherwise it degrades to the pool path.
    if (meteringContext.laneRouting && !meteringContext.isByok) {
      const verdict = await decideChatUsageLane({
        tx,
        organizationId: meteringContext.organizationId,
        userId: meteringContext.userId,
      });
      if (verdict === "unassigned") {
        return { ok: false as const, unassigned: true as const };
      }
      if (verdict === "allowance") {
        return {
          ok: true as const,
          lane: { lane: "allowance" } satisfies UsageLaneDecision,
        };
      }
      if (verdict === "fallback") {
        const forcedModelSelection = resolveFallbackChatSelection(null);
        if (forcedModelSelection !== null) {
          return {
            ok: true as const,
            lane: {
              lane: "fallback",
              forcedModelSelection,
            } satisfies UsageLaneDecision,
          };
        }
      }
    }
    const check = await assertUsageAvailable({
      tx,
      organizationId: meteringContext.organizationId,
      required: meteringContext.cost,
    });
    return check.ok
      ? {
          ok: true as const,
          lane: { lane: "pool" } satisfies UsageLaneDecision,
        }
      : { ok: false as const, unassigned: false as const, error: check.error };
  });
  if (Result.isError(checkResult)) {
    // DB error during pre-flight — surface generic 500 so the
    // user retries; we don't let it look like an over-limit
    // situation when it's our infrastructure that failed.
    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error: checkResult.error,
      statusCode: 500,
      telemetry: "capture",
    });
    return Result.err(
      new HandlerError({
        status: 500,
        code: API_ERROR_CODE.internalServerError,
        message: "Internal server error",
      }),
    );
  }
  const check = checkResult.value;
  if (check.ok) {
    return Result.ok(check.lane);
  }
  if (check.unassigned) {
    return Result.err(memberAssignmentRequiredError());
  }
  return Result.err(
    new HandlerError({
      status: 402,
      code: API_ERROR_CODE.usageLimitExceeded,
      message: check.error.message,
      usage: {
        reason: check.error.reason,
        required: check.error.required,
        available: check.error.available,
      },
    }),
  );
};

type UsagePreflightInput = {
  metering: UsageMeteringConfig | null;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

/**
 * In-handler usage preflight for routes whose AI work is conditional
 * on runtime input (e.g. a template fill that only calls a model when
 * the manifest declares AI fields). The static `requiresUsage` config
 * runs before the handler reads that input, so a deterministic fill
 * would be rejected for AI quota it never spends. Such handlers omit
 * `requiresUsage` and call this after detecting the AI-field signal,
 * only when AI work will actually run.
 *
 * Returns a `HandlerError` carrying the same `402` usage detail
 * (`reason`/`required`/`available`, surfaced by `safeErrorBody`) or a
 * `500` the static path emits, so the caller returns it as `Result.err`
 * and the client sees an unchanged response. `null` means proceed. No-op
 * while `USAGE_ENFORCEMENT_ENABLED` is off, matching the static path.
 */
const checkUsageAvailableForHandler = async ({
  metering,
  organizationId,
  orgAIConfig,
  workspaceId,
  userId,
  safeDb,
}: UsagePreflightInput): Promise<HandlerError<402 | 500> | null> => {
  if (metering === null || !env.USAGE_ENFORCEMENT_ENABLED) {
    return null;
  }
  const meteringContext = resolveMeteringContext({
    metering,
    organizationId,
    orgAIConfig,
    workspaceId,
    userId,
  });
  if (meteringContext.cost <= 0) {
    return null;
  }
  const checkResult = await safeDb(
    async (tx) =>
      await assertUsageAvailable({
        tx,
        organizationId: meteringContext.organizationId,
        required: meteringContext.cost,
      }),
  );
  if (Result.isError(checkResult)) {
    // DB error during pre-flight — surface a generic 500 (the wrapper logs
    // and captures it) so the user retries; we don't let an infrastructure
    // failure look like an over-limit situation.
    return new HandlerError({
      code: API_ERROR_CODE.internalServerError,
      status: 500,
      message: "Internal server error",
      cause: checkResult.error,
    });
  }
  const check = checkResult.value;
  if (check.ok) {
    return null;
  }
  return new HandlerError({
    code: API_ERROR_CODE.usageLimitExceeded,
    status: 402,
    message: check.error.message,
    usage: {
      reason: check.error.reason,
      required: check.error.required,
      available: check.error.available,
    },
  });
};

const CONDITIONAL_USAGE_ALLOWED = "ConditionalUsageAllowed";

export const authorizeHandlerUsage = async <Input extends UsagePreflightInput>(
  input: Input,
) =>
  await authorizeOperation({
    kind: CONDITIONAL_USAGE_ALLOWED,
    input,
    check: async (checkedInput) => {
      const error = await checkUsageAvailableForHandler(checkedInput);
      return error === null ? Result.ok(undefined) : Result.err(error);
    },
  });

/**
 * Above this many estimated units, a queued run must carry an explicit
 * `confirmedUnits` restating its size before it may start.
 */
const RUN_CONFIRMATION_UNITS = 50;

type RunSizePreflightInput = UsagePreflightInput & {
  /** Units the initiator expects the whole run to consume. */
  estimatedUnits: number;
  /** The client's restated estimate; `undefined` when not confirming. */
  confirmedUnits: number | undefined;
};

/**
 * Pre-flight for batch initiators (document reviews, flows) that
 * enqueue work whose total size is known up front. Checks availability
 * for the WHOLE estimate — the per-action preflight would admit a run
 * whose tail cannot settle — and above {@link RUN_CONFIRMATION_UNITS}
 * additionally requires the request to restate the estimate via
 * `confirmedUnits`, else answers a 428 carrying the estimate for the
 * client to confirm. No-op for BYOK settlements (the organization's own
 * key pays) and while `USAGE_ENFORCEMENT_ENABLED` is off.
 */
const checkRunSizeConfirmedForHandler = async ({
  metering,
  estimatedUnits,
  confirmedUnits,
  organizationId,
  orgAIConfig,
  workspaceId,
  userId,
  safeDb,
}: RunSizePreflightInput): Promise<HandlerError<402 | 428 | 500> | null> => {
  if (metering === null || !env.USAGE_ENFORCEMENT_ENABLED) {
    return null;
  }
  // A run that makes no model calls spends nothing; refusing it for AI
  // budget would block plain gate-only or document-only runs.
  if (estimatedUnits <= 0) {
    return null;
  }
  const meteringContext = resolveMeteringContext({
    metering,
    organizationId,
    orgAIConfig,
    workspaceId,
    userId,
  });
  if (meteringContext.isByok) {
    return null;
  }
  const checkResult = await safeDb(
    async (tx) =>
      await assertUsageAvailable({
        tx,
        organizationId: meteringContext.organizationId,
        required: Math.max(estimatedUnits, meteringContext.cost),
      }),
  );
  if (Result.isError(checkResult)) {
    return new HandlerError({
      code: API_ERROR_CODE.internalServerError,
      status: 500,
      message: "Internal server error",
      cause: checkResult.error,
    });
  }
  const check = checkResult.value;
  if (!check.ok) {
    return new HandlerError({
      code: API_ERROR_CODE.usageLimitExceeded,
      status: 402,
      message: check.error.message,
      usage: {
        reason: check.error.reason,
        required: check.error.required,
        available: check.error.available,
      },
    });
  }
  if (estimatedUnits <= RUN_CONFIRMATION_UNITS) {
    return null;
  }
  if (confirmedUnits !== undefined && confirmedUnits >= estimatedUnits) {
    return null;
  }
  return new HandlerError({
    code: API_ERROR_CODE.usageConfirmationRequired,
    status: 428,
    message:
      "This run's estimated size needs an explicit confirmation to start.",
    confirmation: {
      estimatedUnits,
      availableUnits: check.available,
    },
  });
};

const RUN_SIZE_CONFIRMED = "RunSizeConfirmed";

export const authorizeHandlerRunSize = async <
  Input extends RunSizePreflightInput,
>(
  input: Input,
) =>
  await authorizeOperation({
    kind: RUN_SIZE_CONFIRMED,
    input,
    check: async (checkedInput) => {
      const error = await checkRunSizeConfirmedForHandler(checkedInput);
      return error === null ? Result.ok(undefined) : Result.err(error);
    },
  });

const createSafeDirectHandler = <
  TConfig extends InputSchema &
    WriteContract &
    ContentDeliveryDisposition &
    SandboxAccountAccess,
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<TContext, TResult>,
): SafeHandlerCore<TConfig, TContext, TResult> =>
  recordSafeHandler({
    config,
    access: "token",
    handler: async (ctx: TContext): Promise<SafeHandlerResult<TResult>> =>
      await withSafeHandlerExceptionScope(
        ctx,
        async () =>
          await runSafeHandler({
            ctx,
            handler,
            contentDelivery: config.contentDelivery,
          }),
      ),
  });

const safeErrorBody = (error: HandlerError): SafeErrorBody => ({
  ...(error instanceof ProviderCallError &&
  error.providerDiagnostic !== undefined
    ? { providerDiagnostic: error.providerDiagnostic }
    : {}),
  ...(error.code ? { code: error.code } : {}),
  message: error.message,
  ...(error.hint ? { hint: error.hint } : {}),
  ...(error.clause ? { clause: error.clause } : {}),
  ...(error.contactUrl ? { contactUrl: error.contactUrl } : {}),
  ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  ...(error.retryAfterMs === undefined
    ? {}
    : { retryAfterMs: error.retryAfterMs }),
  ...(error.issues ? { issues: error.issues } : {}),
  // Usage-limit 402s carry structured fields so the frontend renders the
  // "x of y units left" modal without parsing the message (see SafeErrorBody).
  ...(error.usage
    ? {
        reason: error.usage.reason,
        required: error.usage.required,
        available: error.usage.available,
      }
    : {}),
  ...(error.confirmation ? { confirmation: error.confirmation } : {}),
  ...(error.error ? { error: error.error } : {}),
  ...(error.claim ? { claim: error.claim } : {}),
  ...error.stepUp,
  ...(error.requiredFields ? { requiredFields: error.requiredFields } : {}),
});

/**
 * A root handler has no validated matter, so it can only announce
 * organization-wide resource sets.
 */
type RootHandlerConfig = HandlerConfig & {
  realtime?: OrganizationResourceSetUpdates | NoResourceSetUpdates;
};

export const createSafeRootHandler = <
  TConfig extends RootHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<RootHandlerContext<TConfig>, TResult> &
    ConfiguredFiniteHandlerGuard<TConfig, TResult>,
  dependencies?: HandlerAdmissionDependencies,
): SafeHandlerDefinition<TConfig, RootHandlerContext<TConfig>, TResult> => {
  const core = createSafeScopedHandler("member", config, handler, dependencies);
  return { ...core, run: memberRun(config, core.handler) };
};

export const createSafeHandler = <
  TConfig extends WorkspaceHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<WorkspaceHandlerContext<TConfig>, TResult> &
    ConfiguredFiniteHandlerGuard<TConfig, TResult>,
  dependencies?: HandlerAdmissionDependencies,
): SafeHandlerDefinition<
  TConfig,
  WorkspaceHandlerContext<TConfig>,
  TResult
> => {
  const core = createSafeScopedHandler(
    "workspace",
    config,
    handler,
    dependencies,
  );
  return { ...core, run: workspaceRun(config, core.handler) };
};

type SessionHandlerDependencies = {
  checkAccountOperation?: typeof checkRestrictedAccountOperation;
};

export const createSafeSessionHandler = <
  TConfig extends SessionHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<SessionHandlerContext<TConfig>, TResult>,
  {
    checkAccountOperation = checkRestrictedAccountOperation,
  }: SessionHandlerDependencies = {},
): SafeHandlerDefinition<TConfig, SessionHandlerContext<TConfig>, TResult> => {
  const core = recordSafeHandler({
    config,
    access: "session",
    handler: async (
      ctx: SessionHandlerContext<TConfig>,
    ): Promise<SafeHandlerResult<TResult>> =>
      await withSafeHandlerExceptionScope(ctx, async () => {
        if (requiresAccountCheck(config.accountAccess)) {
          const accountAccess = checkAccountOperation(
            ctx.user.email,
            config.accountAccess,
          );
          if (Result.isError(accountAccess)) {
            return toSafeStatusResponse(403, {
              code: "account_access_unavailable",
              message: "This operation is unavailable for this account.",
            });
          }
        }
        return await runSafeHandler({
          ctx,
          handler,
          contentDelivery: config.contentDelivery,
        });
      }),
  });
  return {
    ...core,
    run: async (request) => {
      const account = await authenticateSession(request.ctx, config);
      if (!account.ok) {
        return account.answer;
      }
      const input = await decodeRouteInput(
        config,
        request,
        await request.readBody(),
      );
      return await core.handler({
        ...routeContext(request, input),
        ...account.caller,
      });
    },
  };
};

/** A token route's request before any schema has read it. */
export type RawRouteInput = {
  readonly request: Request;
  readonly params: RawParams;
  readonly query: QueryRecord;
  /** The body as its content type reads, unvalidated: treat every field as unknown. */
  readonly body: unknown;
};

export type TokenHandlerConfig = InputSchema &
  WriteContract &
  CapabilityDescription &
  ContentDeliveryDisposition &
  CapabilityAccess &
  SandboxAccountAccess & {
    mcp: McpExposure;
  };

/**
 * A token route's credential check: what the credential proves about the
 * caller, or the error that refuses it. It reads the raw request, so treat
 * every field as unknown; refuse a malformed credential exactly like an
 * unknown one.
 */
export type VerifyCaller<TCaller> = (
  raw: RawRouteInput,
) => Result<TCaller, HandlerError> | Promise<Result<TCaller, HandlerError>>;

type TokenHandlerContext<
  TConfig extends TokenHandlerConfig,
  TCaller,
> = RouteContext<TConfig> & {
  /** What the credential check proved about the caller. */
  caller: TCaller;
};

/**
 * Like `createSafeSessionHandler`, but the caller proves itself with a
 * credential in the request (a collab room token, a one-time link code), not a
 * session. `verifyCaller` runs on the raw request before any schema, so an
 * unauthenticated probe is refused without learning the shape of the input;
 * the strict schemas then validate the rest as usual. The handler gets the
 * same structured error capture, safe-status responses, and request logging
 * as the org-scoped variants without claiming a `user.id` that isn't present.
 */
export const createSafeTokenHandler = <
  TConfig extends TokenHandlerConfig,
  TCaller,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  verifyCaller: VerifyCaller<TCaller>,
  handler: SafeHandlerFn<TokenHandlerContext<TConfig, TCaller>, TResult>,
): SafeHandlerDefinition<
  TConfig,
  TokenHandlerContext<TConfig, TCaller>,
  TResult
> => {
  const core = createSafeDirectHandler(config, handler);
  return {
    ...core,
    run: async (request) => {
      const rawBody = await request.readBody();
      const verdict = await verifyCaller({
        request: request.ctx.request,
        params: request.ctx.params,
        query: request.ctx.query,
        body: rawBody,
      });
      if (Result.isError(verdict)) {
        return toSafeStatusResponse(
          verdict.error.status,
          safeErrorBody(verdict.error),
        );
      }
      const input = await decodeRouteInput(config, request, rawBody);
      return await core.handler({
        ...routeContext(request, input),
        caller: verdict.value,
      });
    },
  };
};

export type PublicHandlerConfig = InputSchema &
  WriteContract &
  CapabilityDescription &
  ContentDeliveryDisposition &
  CapabilityAccess &
  SandboxAccountAccess & {
    cache: RouteCachePolicy;
    /** `own`: the route answers CORS itself (an any-origin discovery document). */
    cors?: "own";
    mcp: McpExposure;
  };

export type PublicHandlerContext<
  TConfig extends PublicHandlerConfig = PublicHandlerConfig,
> = RouteContext<TConfig>;

/**
 * Handlers this factory produced. A public route census asserts that every
 * mounted handler is in here, which a naming convention cannot guarantee:
 * a raw function passed to `.get()` reads the same at the call site.
 */
type PublicHandlerRegistration = {
  cache: RouteCachePolicy;
  readTimeout: "route-class" | "none";
};

const safePublicHandlers = new WeakMap<object, PublicHandlerRegistration>();

/** Whether a mounted route handler came out of a public handler factory. */
export const isSafePublicHandler = (handler: unknown): boolean =>
  typeof handler === "function" && safePublicHandlers.has(handler);

export const isPublicReadBudgetHandler = (handler: unknown): boolean =>
  typeof handler === "function" &&
  safePublicHandlers.get(handler)?.readTimeout === "route-class";

type SafePublicStatusResponse<TStatusCode extends HandlerErrorStatusCode> =
  TStatusCode extends HandlerErrorStatusCode
    ? HttpStatusResponse<
        TStatusCode,
        string | ReturnType<typeof projectPublicErrorBody>
      >
    : never;

function toSafePublicStatusResponse<TStatusCode extends HandlerErrorStatusCode>(
  statusCode: TStatusCode,
  body: string | ReturnType<typeof projectPublicErrorBody>,
): SafePublicStatusResponse<TStatusCode>;
function toSafePublicStatusResponse(
  statusCode: HandlerErrorStatusCode,
  body: string | ReturnType<typeof projectPublicErrorBody>,
) {
  return status(statusCode, body);
}

/**
 * For unauthenticated routes that intentionally expose public data.
 * The handler still gets structured error capture and sanitized
 * responses, but no user, org, workspace, or permission context.
 * Error bodies keep their ceremony fields for self-authorizing endpoints;
 * corpus routes use `createSafeBoundedPublicHandler`.
 */
export const createSafePublicHandler = <
  TConfig extends PublicHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<PublicHandlerContext<TConfig>, TResult>,
) => {
  const definition = recordSafeHandler({
    config,
    access: "public",
    cache: config.cache,
    ...(config.cors === undefined ? {} : { cors: config.cors }),
    handler: async (ctx: PublicHandlerContext<TConfig>) =>
      await withSafeHandlerExceptionScope(ctx, async () => {
        const response = await runSafeHandler({
          ctx,
          handler,
          contentDelivery: config.contentDelivery,
        });
        return response;
      }),
  });
  safePublicHandlers.set(definition.handler, {
    cache: config.cache,
    readTimeout: "none",
  });
  return { ...definition, run: publicRun(config, definition.handler) };
};

/** Public routes: no caller, the input only. */
const publicRun =
  <TConfig extends PublicHandlerConfig>(
    config: TConfig,
    handler: (ctx: PublicHandlerContext<TConfig>) => Promise<unknown>,
  ) =>
  async (request: RouteRequest): Promise<unknown> =>
    await handler(
      routeContext(
        request,
        await decodeRouteInput(config, request, await request.readBody()),
      ),
    );

const toBoundedPublicErrorStatus = (
  statusCode: HandlerErrorStatusCode,
  body: SafeErrorBody,
) => toSafePublicStatusResponse(statusCode, projectPublicErrorBody(body));

/** What a handler answers with a 200: its result minus statuses and raw bodies. */
type SuccessPayload<TResult> = TResult extends
  HttpStatusResponse<infer _Code, infer _Body> | Response
  ? never
  : TResult;

/**
 * A payload with every array and property readonly. Primitives, branded ones
 * included, and `unknown` stay as they are; the mapped type is homomorphic, so
 * tuples stay tuples.
 */
export type ReadonlyWire<T> = unknown extends T
  ? T
  : T extends string | number | boolean | bigint | null | undefined
    ? T
    : { readonly [Key in keyof T]: ReadonlyWire<T[Key]> };

/**
 * Binds a public route's 200 schema to the data its handler returns.
 *
 * Typing the handler against its schema only checks that the payload is
 * assignable to it, and the web client is typed from the schema, so a schema
 * looser than the data (a plain
 * string for a `SafeId`, `X | null` for `X`, `number` for a literal, a key the
 * data never has) compiles and misdescribes the wire. Requiring the reverse
 * direction too makes the two mutually assignable. Readonly differences do not
 * count: the schema is compared with a readonly view of the data, which a
 * readonly or a mutable schema array are both assignable to.
 */
export type ExactSuccessSchemaGuard<TConfig, TResult> = TConfig extends {
  response: { 200: infer TSuccessSchema extends AnySchema };
}
  ? [SuccessPayload<TResult>] extends [never]
    ? unknown
    : [StandardSchemaV1.InferOutput<TSuccessSchema>] extends [
          ReadonlyWire<SuccessPayload<TResult>>,
        ]
      ? unknown
      : {
          responseSchemaLooserThanData: {
            schema: StandardSchemaV1.InferOutput<TSuccessSchema>;
            data: SuccessPayload<TResult>;
          };
        }
  : unknown;

/**
 * `createSafeBoundedPublicHandler` without the schema guard, for a factory
 * whose result type is still generic where it calls this one; that factory
 * applies `ExactSuccessSchemaGuard` on its own entry points instead.
 */
export const createSafeUncheckedBoundedPublicHandler = <
  TConfig extends PublicHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<PublicHandlerContext<TConfig>, TResult>,
) => {
  const definition = recordSafeHandler({
    config,
    access: "public",
    cache: config.cache,
    ...(config.cors === undefined ? {} : { cors: config.cors }),
    handler: async (ctx: PublicHandlerContext<TConfig>) =>
      await withSafeHandlerExceptionScope(ctx, async () => {
        const result = await runPublicReadRequest(
          ctx,
          async () =>
            await runSafeHandlerWith({
              ctx,
              handler,
              contentDelivery: config.contentDelivery,
              toErrorStatus: toBoundedPublicErrorStatus,
            }),
        );
        const response =
          // Projection is idempotent, so factory-built statuses pass through it
          // unchanged; handler-returned statuses are bounded the same way.
          result instanceof HttpStatusResponse && result.code >= 400
            ? toSafePublicStatusResponse(
                result.code,
                typeof result.response === "string"
                  ? truncateTextBytes(
                      result.response,
                      PUBLIC_ERROR_TEXT_BYTES.statusText,
                    )
                  : projectPublicErrorBody(result.response),
              )
            : result;
        return response;
      }),
  });
  safePublicHandlers.set(definition.handler, {
    cache: config.cache,
    readTimeout: "route-class",
  });
  return { ...definition, run: publicRun(config, definition.handler) };
};

/**
 * A public corpus route: every error answers with the bounded public body
 * (`safePublicHandlerErrorResponseSchema`), whether the failure is handled
 * by the factory or returned as a status by the handler itself.
 */
export const createSafeBoundedPublicHandler = <
  TConfig extends PublicHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<PublicHandlerContext<TConfig>, TResult> &
    NoInfer<ExactSuccessSchemaGuard<TConfig, TResult>>,
) => createSafeUncheckedBoundedPublicHandler(config, handler);

/**
 * Whether a failure also reaches the exception reporter.
 *
 * `"capture"` is for faults the team must act on: a panic, a database
 * failure, a security denial. `"log-only"` is for outcomes a handler
 * deliberately answered — a rejected payload, a missing entity — whose
 * volume follows client behaviour and whose detail is already in the
 * structured record. Every call site states one; there is no default, so a
 * new branch cannot silently pick the noisy side.
 */
type SafeErrorTelemetry = "capture" | "log-only";

const safeErrorTelemetryDisposition = (
  statusCode: number,
  code?: string,
): SafeErrorTelemetry =>
  statusCode >= 500 && code !== ACTION_ADMISSION_CODES.featureDisabled
    ? "capture"
    : "log-only";

type LogAndCaptureSafeErrorProps = {
  request: Request;
  route: string;
  error: unknown;
  statusCode: number;
  telemetry: SafeErrorTelemetry;
};

/**
 * Structural attributes for an error's `.cause` chain, so nested
 * wrappers do not hide the underlying failure.
 *
 * Each level records its type and, when it carries one, its status.
 * The status is what makes the level useful: a `toXError(cause)`
 * wrapper and its cause are usually both `HandlerError`, so type
 * alone repeats one uninformative string while the wrapper's own
 * generic 500 is the only status logged. The cause's 403
 * (misconfiguration), 400 (unsupported input) or 502 (upstream run
 * failure) is what names the failure. A status is a number, so this
 * stays as non-PII as the rest of the sink. Read from the shared failure
 * snapshot.
 */
export const errorCauseChainAttributes = (
  error: Error,
): Record<string, string | number> => causeChainAttributes(readEvidence(error));

const logAndCaptureSafeError = ({
  request,
  route,
  error,
  statusCode,
  telemetry,
}: LogAndCaptureSafeErrorProps) => {
  const reqCtx = getRequestContext();
  const evidence = readEvidence(error);
  const severity =
    statusCode >= 500 &&
    !(
      HandlerError.is(error) &&
      error.code === ACTION_ADMISSION_CODES.featureDisabled
    )
      ? "ERROR"
      : "WARN";
  const grading = observeShadow({
    error,
    sink: SHADOW_SINKS.handler,
    channel: legacyChannelOf({ severity, capture: telemetry === "capture" }),
    request,
    route,
    requestState: { answeredStatus: statusCode },
  });

  const attributes: Record<string, string | number | boolean> = {
    "http.method": request.method,
    "http.route": route,
    "http.status_code": statusCode,
    "request.duration_ms": Math.round(
      reqCtx ? performance.now() - reqCtx.startTime : 0,
    ),
    "error.type": errorTag(error),
  };

  Object.assign(attributes, requestErrorStatusFields(evidence));
  Object.assign(attributes, causeChainAttributes(evidence));

  // Every answered failure is un-diagnosable without this: the message and
  // stack are redacted from every sink, leaving only `error.type`. The
  // diagnostic identity (class, stable code and source positions) is non-PII
  // and uses keys that survive the logger's redaction, so a failure always
  // carries a code location. A 4xx needs it at least as much as a panic —
  // `error.type` reads `HandlerError` at every one of the dozens of sites
  // that reject a request payload, so the frame is the only thing that says
  // which rejection fired.
  Object.assign(attributes, identityFields(evidence));

  const privateInputRequest = /\/chat\/threads\/[^/]+\/secrets\/[^/]+$/u.test(
    new URL(request.url).pathname,
  );
  if (isLocalDevOpen() && env.DEBUG_UNREDACTED_ERRORS && !privateInputRequest) {
    Object.assign(attributes, unredactedErrorFields(error));
  }

  if (reqCtx?.requestId) {
    attributes["request.id"] = reqCtx.requestId;
  }

  if (reqCtx?.posthogDistinctId) {
    attributes["posthogDistinctId"] = reqCtx.posthogDistinctId;
  }

  if (reqCtx?.sessionId) {
    attributes["sessionId"] = reqCtx.sessionId;
  }

  if (reqCtx?.organizationId) {
    attributes["enduser.organization_id"] = reqCtx.organizationId;
  }

  // The owner's grade rides along in shadow; it decides nothing here yet.
  Object.assign(attributes, shadowFields(grading));

  // Operator feature refusals retain 503 on the wire while remaining an
  // expected warning. Other server failures keep their error severity.
  if (severity === "ERROR") {
    logger.error("request.failed", attributes);
  } else {
    logger.warn("request.failed", attributes);
  }

  // Reporting is a separate decision from grading: a rejected payload is a
  // client outcome the handler answered, and routing it to `$exception`
  // would drown real faults in traffic the client controls. The record above
  // already carries the rejecting frame.
  if (telemetry === "capture") {
    captureObservedError(error, {
      // HTTP routes are declared templates; MCP routes carry capability IDs.
      // Neither contains resolved request values.
      fingerprintKey: "api.safeHandlerFailure",
      scope: route.startsWith("mcp:invoke_capability/")
        ? { type: "handler", handlerId: route }
        : { type: "request", method: request.method, routeTemplate: route },
      request,
      context: {
        method: request.method,
        route,
      },
      observation: grading,
    });
  }
};
