import type { Err, UnhandledException } from "better-result";
import { Result } from "better-result";
import type {
  Context,
  ElysiaCustomStatusResponse,
  InputSchema,
  UnwrapRoute,
} from "elysia";
import { status } from "elysia";

import type { ModelRole } from "@stll/ai-catalog";
import type { PermissionInput, roles } from "@stll/permissions";

import type { SafeDb, ScopedDb } from "@/api/db";
import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureRequestError } from "@/api/lib/analytics";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type {
  HandlerErrorCode,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";
import {
  errorFingerprint,
  errorTag,
  safeErrorCause,
  unredactedErrorFields,
} from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { getRequestContext } from "@/api/lib/observability/request-context";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import {
  getTanStackTextModelInfoForRole,
  resolveEffectiveServiceTierForProvider,
} from "@/api/lib/tanstack-ai-models";
import { assertUsageAvailable } from "@/api/lib/usage";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
// Type-only: derive the closed tool-name union from the single MCP registry
// so `mcp: { type: "tool", name }` typechecks against the real tools. The
// import is erased at build time and never creates a runtime import cycle
// (api-handlers must stay importable without pulling in the MCP graph).
import type { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-definitions";

/**
 * The closed set of curated static MCP tool names. Every `type: "tool"` and
 * `type: "covered"` disposition references one of these; the coverage guard
 * (`apps/api/scripts/mcp-coverage-guard.ts`) cross-checks the runtime registry.
 */
export type McpToolName = (typeof MCP_STATIC_TOOL_NAMES)[number];

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
 */
export type McpCapabilityReason =
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
  | "chat_thread_ui";

/**
 * Approved, permanent reasons an endpoint is intentionally never reachable from
 * an agent surface at all: transport/plumbing/UI mechanics and the approved
 * permanent exclusions. Unlike `McpCapabilityReason`, these stay out of the
 * capability catalog entirely. Closed union (no freetext): a new waiver category
 * is a deliberate, reviewed addition here.
 *
 * - `auth_plumbing`: better-auth / sign-in / verification / session routes.
 * - `upload_mechanics`: presign / finalize / abort / preflight upload steps.
 * - `realtime_stream`: SSE / event-stream endpoints.
 * - `session_token_exchange`: folio-collab and desktop-edit token/session
 *   exchange handlers that authorize themselves from a body/param token.
 * - `webhook`: inbound webhooks from external providers.
 * - `dev_only`: routes mounted only in development.
 * - `account_lifecycle`: account deletion / lifecycle flows.
 * - `hosted_billing`: hosted-billing checkout / setup / management plumbing.
 * - `mcp_transport`: the MCP transport / connector routes themselves.
 * - `health_infra`: health and smoke endpoints.
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
 */
export type McpInternalReason =
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
  | "native_tool_ui";

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
  | { type: "tool"; name: McpToolName }
  | { type: "covered"; by: McpToolName }
  | { type: "capability"; reason: McpCapabilityReason }
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
   * Logical model role recorded on the consumption ledger row.
   * Defaults to `"chat"`. Set to the role the handler will pass
   * to the model resolver so cross-cutting analytics match
   * the actual model.
   */
  modelRole?: ModelRole;
};

export type HandlerConfig = InputSchema & {
  permissions: PermissionInput;
  requiresUsage?: UsageMeteringConfig;
  mcp: McpExposure;
};

export type SessionHandlerConfig = InputSchema & {
  mcp: McpExposure;
};

type ConfigRouteSchema<TConfig extends HandlerConfig> = UnwrapRoute<
  Omit<TConfig, "permissions" | "mcp">
>;

type SessionConfigRouteSchema<TConfig extends SessionHandlerConfig> =
  UnwrapRoute<Omit<TConfig, "mcp">>;

type SessionHandlerContext<
  TConfig extends SessionHandlerConfig = SessionHandlerConfig,
> = Context<SessionConfigRouteSchema<TConfig>> & {
  user: {
    id: SafeId<"user">;
  };
};

type BaseHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  Context<ConfigRouteSchema<TConfig>> & {
    user: {
      id: SafeId<"user">;
    };
    session: {
      activeOrganizationId: SafeId<"organization">;
    };
    scopedDb: ScopedDb;
    safeDb: SafeDb;
    /** Resolve non-deleting workspace IDs only when an operation spans matters. */
    getActiveWorkspaceIds: () => Promise<SafeId<"workspace">[]>;
    /** Resolve every accessible workspace only when status metadata is needed. */
    getAccessibleWorkspaces: () => Promise<AccessibleWorkspace[]>;
    /** Resolve one workspace by primary key without expanding the access set. */
    getWorkspaceAccess: (
      workspaceId: SafeId<"workspace">,
    ) => Promise<AccessibleWorkspace | null>;
    memberRole: {
      role: keyof typeof roles;
    };
    orgAIConfig: OrgAIConfig | null;
    /**
     * Whether stella may annotate AI requests for this org with
     * prompt-cache markers. Threaded through to the model resolver;
     * provider adapters strip any markers when
     * `false` regardless of what call sites set.
     */
    promptCachingEnabled: boolean;
    /**
     * Records an audit row in the supplied transaction. Identity
     * fields (org/user/IP/UA) are bound from the request context;
     * workspaceId defaults to ctx.workspaceId on workspace handlers
     * or null on root handlers, and can be overridden per event.
     */
    recordAuditEvent: AuditRecorder;
    /**
     * Builds a recorder with an overridden default workspaceId.
     * Use when threading audit recording through helpers that
     * don't receive the handler ctx (cross-workspace operations,
     * shared copy/move utilities).
     */
    createAuditRecorder: (opts?: {
      workspaceId?: SafeId<"workspace"> | null;
    }) => AuditRecorder;
  };

type RootHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig>;

type WorkspaceHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig> & {
    workspaceId: SafeId<"workspace">;
  };

type SafeHandlerError =
  | DatabaseError
  | DatabaseRlsError
  | HandlerError
  | UnhandledException;

type SafeErrorBody = {
  code?: HandlerErrorCode | undefined;
  message: string;
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
};

// The conditional form is intentional: it keeps status unions distributive so
// Eden sees distinct error codes instead of a single widened response.
type SafeStatusResponse<TStatusCode extends HandlerErrorStatusCode> =
  TStatusCode extends HandlerErrorStatusCode
    ? ElysiaCustomStatusResponse<TStatusCode, SafeErrorBody>
    : never;

/**
 * Success payloads must be non-nullish, including every union member.
 * Elysia serializes a bare `null`/`undefined` return as a 200 with an
 * empty body, which Eden parses as `""` on the client — so a payload
 * typed `T | null` arrives as `T | ""` at runtime and breaks optional
 * chaining one property deep. Model absence as a field instead
 * (`{ entitlement: null }`, `{ items: [] }`); void mutations return a
 * minimal object such as `{}`.
 */
type SafeHandlerPayload = NonNullable<unknown>;

type SafeHandlerResult<TResult> =
  | TResult
  | SafeStatusResponse<HandlerErrorStatusCode>;

/**
 * The async-generator a safe handler runs: it may `yield*` intermediate
 * `Result.await(...)` failures (the `Err` yield) and finally returns a
 * `Result<TResult, …>`.
 *
 * Annotate an *extracted* handler generator with this whenever its result must
 * reach the client typed. TypeScript cannot infer an async generator's return
 * type across `yield*` delegation, so a handler written as
 * `createSafeRootHandler(cfg, (ctx) => yield* myHandler(ctx))` silently widens
 * `TResult` (and the Eden response type) to `unknown` unless `myHandler` is
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

type SafeHandlerDefinition<
  TConfig extends InputSchema = InputSchema,
  TContext = Context<UnwrapRoute<TConfig>>,
  TResult extends SafeHandlerPayload = SafeHandlerPayload,
> = {
  config: TConfig;
  handler: (ctx: TContext) => Promise<SafeHandlerResult<TResult>>;
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

type SafeHandlerLogContext = {
  request: Request;
  route: string;
};

const runSafeHandler = async <
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
>(
  ctx: TContext,
  handler: SafeHandlerFn<TContext, TResult>,
): Promise<SafeHandlerResult<TResult>> => {
  try {
    const result = await Result.gen(() => handler(ctx));

    if (Result.isOk(result)) {
      return result.value;
    }

    const error = result.error;

    if (HandlerError.is(error)) {
      const statusCode = error.status;

      if (statusCode >= 500) {
        logAndCaptureSafeError({
          request: ctx.request,
          route: ctx.route,
          error,
          statusCode,
        });
      }

      return toSafeStatusResponse(error.status, safeErrorBody(error));
    }

    if (DatabaseError.is(error)) {
      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 500,
      });

      return toSafeStatusResponse(500, {
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
      });

      return toSafeStatusResponse(400, {
        code: API_ERROR_CODE.accessDenied,
        message: "Access denied",
      });
    }

    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error,
      statusCode: 500,
    });

    return toSafeStatusResponse(500, {
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
    if (HandlerError.is(error)) {
      if (error.status >= 500) {
        logAndCaptureSafeError({
          request: ctx.request,
          route: ctx.route,
          error,
          statusCode: error.status,
        });
      }
      return toSafeStatusResponse(error.status, safeErrorBody(error));
    }

    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error,
      statusCode: 500,
    });

    return toSafeStatusResponse(500, {
      code: API_ERROR_CODE.internalServerError,
      message: "Internal server error",
    });
  }
};

const createSafeScopedHandler = <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<TContext, TResult>,
): SafeHandlerDefinition<TConfig, TContext, TResult> => ({
  config,
  handler: async (ctx): Promise<SafeHandlerResult<TResult>> => {
    if (!hasMemberPermission(ctx.memberRole, config.permissions)) {
      return toSafeStatusResponse(403, {
        code: API_ERROR_CODE.forbidden,
        message: "Forbidden",
      });
    }

    // Resolve the metering context only when enforcement is on. It reads
    // the org AI provider config to detect BYOK, which panics when no
    // provider is configured; doing it unconditionally — before the
    // handler's own requireAIAvailable check — would turn a missing-AI
    // 403 into a 500, and would be wasted work while enforcement is off.
    if (config.requiresUsage && env.USAGE_ENFORCEMENT_ENABLED) {
      const meteringContext = resolveMeteringContext({
        metering: config.requiresUsage,
        organizationId: ctx.session.activeOrganizationId,
        orgAIConfig: ctx.orgAIConfig,
        workspaceId: hasWorkspaceId(ctx) ? ctx.workspaceId : null,
        userId: ctx.user.id,
      });
      const preflight = await runUsagePreflight({ ctx, meteringContext });
      if (preflight !== null) {
        return preflight;
      }
    }

    return await runSafeHandler(ctx, handler);
  },
});

type ResolvedMeteringContext = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  actionType: UsageActionType;
  serviceTier: UsageServiceTier;
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
  const modelRole = metering.modelRole ?? "chat";
  const modelInfo = getTanStackTextModelInfoForRole(modelRole, orgAIConfig, {
    organizationId,
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
}): Promise<SafeStatusResponse<402 | 500> | null> => {
  if (meteringContext.cost <= 0) {
    return null;
  }
  const checkResult = await ctx.safeDb(
    async (tx) =>
      await assertUsageAvailable({
        tx,
        organizationId: meteringContext.organizationId,
        required: meteringContext.cost,
      }),
  );
  if (Result.isError(checkResult)) {
    // DB error during pre-flight — surface generic 500 so the
    // user retries; we don't let it look like an over-limit
    // situation when it's our infrastructure that failed.
    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error: checkResult.error,
      statusCode: 500,
    });
    return toSafeStatusResponse(500, {
      code: API_ERROR_CODE.internalServerError,
      message: "Internal server error",
    });
  }
  const check = checkResult.value;
  if (check.ok) {
    return null;
  }
  return toSafeStatusResponse(402, {
    code: API_ERROR_CODE.usageLimitExceeded,
    message: check.error.message,
    reason: check.error.reason,
    required: check.error.required,
    available: check.error.available,
  });
};

type UsagePreflightInput = {
  metering: UsageMeteringConfig;
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
export const assertUsageAvailableForHandler = async ({
  metering,
  organizationId,
  orgAIConfig,
  workspaceId,
  userId,
  safeDb,
}: UsagePreflightInput): Promise<HandlerError<402 | 500> | null> => {
  if (!env.USAGE_ENFORCEMENT_ENABLED) {
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

const createSafeDirectHandler = <
  TConfig extends InputSchema,
  TContext extends SafeHandlerLogContext,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<TContext, TResult>,
): SafeHandlerDefinition<TConfig, TContext, TResult> => ({
  config,
  handler: async (ctx): Promise<SafeHandlerResult<TResult>> =>
    await runSafeHandler(ctx, handler),
});

const safeErrorBody = (error: HandlerError): SafeErrorBody => ({
  ...(error.code ? { code: error.code } : {}),
  message: error.message,
  // Usage-limit 402s carry structured fields so the frontend renders the
  // "x of y units left" modal without parsing the message (see SafeErrorBody).
  ...(error.usage
    ? {
        reason: error.usage.reason,
        required: error.usage.required,
        available: error.usage.available,
      }
    : {}),
});

export const createSafeRootHandler = <
  TConfig extends HandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<RootHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, RootHandlerContext<TConfig>, TResult> =>
  createSafeScopedHandler(config, handler);

export const createSafeHandler = <
  TConfig extends HandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<WorkspaceHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, WorkspaceHandlerContext<TConfig>, TResult> =>
  createSafeScopedHandler(config, handler);

export const createSafeSessionHandler = <
  TConfig extends SessionHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<SessionHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, SessionHandlerContext<TConfig>, TResult> =>
  createSafeDirectHandler(config, handler);

export type TokenHandlerConfig = InputSchema & {
  mcp: McpExposure;
};

type TokenHandlerContext<
  TConfig extends TokenHandlerConfig = TokenHandlerConfig,
> = Context<UnwrapRoute<Omit<TConfig, "mcp">>>;

/**
 * Like `createSafeSessionHandler`, but the framework does not
 * authenticate the caller — the handler authorizes itself from a
 * body / param token (e.g. folio-collab session tokens). The
 * factory gives the handler the same structured error capture,
 * safe-status responses, and request logging as the org-scoped
 * variants without claiming a `user.id` that isn't present.
 */
export const createSafeTokenHandler = <
  TConfig extends TokenHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<TokenHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, TokenHandlerContext<TConfig>, TResult> =>
  createSafeDirectHandler(config, handler);

export type PublicHandlerConfig = InputSchema & {
  mcp: McpExposure;
};

type PublicHandlerContext<
  TConfig extends PublicHandlerConfig = PublicHandlerConfig,
> = Context<UnwrapRoute<Omit<TConfig, "mcp">>>;

/**
 * For unauthenticated routes that intentionally expose public data.
 * The handler still gets structured error capture and sanitized
 * responses, but no user, org, workspace, or permission context.
 */
export const createSafePublicHandler = <
  TConfig extends PublicHandlerConfig,
  TResult extends SafeHandlerPayload,
>(
  config: TConfig,
  handler: SafeHandlerFn<PublicHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, PublicHandlerContext<TConfig>, TResult> =>
  createSafeDirectHandler(config, handler);

type LogAndCaptureSafeErrorProps = {
  request: Request;
  route: string;
  error: unknown;
  statusCode: number;
};

const getErrorStatusCode = (error: Error): number | undefined => {
  try {
    if ("statusCode" in error) {
      const statusCode: unknown = Reflect.get(error, "statusCode");
      if (typeof statusCode === "number") {
        return statusCode;
      }
    }

    if ("status" in error) {
      const statusValue: unknown = Reflect.get(error, "status");
      if (typeof statusValue === "number") {
        return statusValue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const logAndCaptureSafeError = ({
  request,
  route,
  error,
  statusCode,
}: LogAndCaptureSafeErrorProps) => {
  const reqCtx = getRequestContext(request);

  const attributes: Record<string, string | number | boolean> = {
    "http.method": request.method,
    "http.route": route,
    "http.status_code": statusCode,
    "request.duration_ms": Math.round(
      reqCtx ? performance.now() - reqCtx.startTime : 0,
    ),
    "error.type": errorTag(error),
  };

  if (error instanceof Error) {
    const errorStatusCode = getErrorStatusCode(error);
    if (errorStatusCode !== undefined) {
      attributes["error.status_code"] = errorStatusCode;
    }
    // Walk up to three levels of `.cause` so nested wrappers do not
    // hide the underlying failure type.
    const seen = new WeakSet<object>([error]);
    let cause = safeErrorCause(error);
    let depth = 1;
    while (cause instanceof Error && depth <= 3 && !seen.has(cause)) {
      seen.add(cause);
      const prefix = depth === 1 ? "error.cause" : `error.cause${depth}`;
      attributes[`${prefix}.type`] = errorTag(cause);
      cause = safeErrorCause(cause);
      depth++;
    }
  }

  // 5xx are the un-diagnosable class: the message and stack are
  // redacted from every sink, leaving only `error.type`. Attach a
  // non-PII structural fingerprint (class, stable code, top
  // `file:line:col` frames) under keys that survive the logger's PII
  // redaction so a panic always carries a code location.
  if (statusCode >= 500) {
    Object.assign(attributes, errorFingerprint(error));

    if (env.DEBUG_UNREDACTED_ERRORS) {
      Object.assign(attributes, unredactedErrorFields(error));
    }
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

  logger.error("request.failed", attributes);

  captureRequestError(error, {
    request,
    context: {
      method: request.method,
      route,
    },
  });
};
