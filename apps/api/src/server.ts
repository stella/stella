import cors from "@elysia/cors";
import { Elysia } from "elysia";
import type { Context } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { aiAutocompleteRoute } from "@/api/handlers/ai-autocomplete/routes";
import { aiConfigPublicRoute } from "@/api/handlers/ai-config/routes";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { auditLogsRoute } from "@/api/handlers/audit-logs/routes";
import {
  authCapabilitiesRoute,
  authMetadataRoute,
} from "@/api/handlers/auth/routes";
import { authUiRoute } from "@/api/handlers/auth/ui-routes";
import { bilingualTranslationsRoute } from "@/api/handlers/bilingual-translations/routes";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { catalogueRoute } from "@/api/handlers/catalogue/routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import {
  clauseCategoriesRoute,
  clausesRoute,
} from "@/api/handlers/clauses/routes";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { devPublicRoute, devRoute } from "@/api/handlers/dev/routes";
import { documentReviewPassagesRoute } from "@/api/handlers/document-reviews/passages-routes";
import { documentReviewsRoute } from "@/api/handlers/document-reviews/routes";
import { documentTranslationsRoute } from "@/api/handlers/document-translations/routes";
import { documentTypesRoute } from "@/api/handlers/document-types/routes";
import { docxSuggestionsRoute } from "@/api/handlers/docx-suggestions/routes";
import { desktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { externalPreviewRoute } from "@/api/handlers/external-preview/routes";
import { feedbackPublicRoute } from "@/api/handlers/feedback/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { flowsRoute } from "@/api/handlers/flows/routes";
import { flowRunsRoute } from "@/api/handlers/flows/run-route";
import { isFolioCollabRateLimitedPath } from "@/api/handlers/folio-collab/rate-limit";
import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { hostedUsageWebhookRoute } from "@/api/handlers/hosted-usage-webhook/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { legislationCorpusRoute } from "@/api/handlers/legislation/corpus-routes";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { legislationRoute } from "@/api/handlers/legislation/routes";
import { listsRoute } from "@/api/handlers/lists/routes";
import { handleMcpAppSandboxRequest } from "@/api/handlers/mcp-app-sandbox/routes";
import { mcpConnectorsRoute } from "@/api/handlers/mcp-connectors/routes";
import { mcpRoute } from "@/api/handlers/mcp/routes";
import { handleMcpPreflightRequest } from "@/api/handlers/mcp/routes-core";
import {
  createMcpTransportAddressRateLimitOptions,
  createMcpTransportRateLimitOptions,
} from "@/api/handlers/mcp/transport-rate-limit";
import { meRoute } from "@/api/handlers/me/routes";
import { memoriesRoute } from "@/api/handlers/memories/routes";
import { notificationsRoute } from "@/api/handlers/notifications/routes";
import { operatorRoute } from "@/api/handlers/operator/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { playbooksRoute } from "@/api/handlers/playbooks/routes";
import { playbookRunsRoute } from "@/api/handlers/playbooks/run-route";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { initBuiltinReportTemplates } from "@/api/handlers/reports/builtin-templates";
import { initReportExportWorker } from "@/api/handlers/reports/report-export-queue";
import { reportsRoute } from "@/api/handlers/reports/routes";
import { savedSearchesRoute } from "@/api/handlers/saved-searches/routes";
import { searchRoute } from "@/api/handlers/search/routes";
import { sharepointRoute } from "@/api/handlers/sharepoint/routes";
import { signalsRoute } from "@/api/handlers/signals/routes";
import { skillsRoute } from "@/api/handlers/skills/routes";
import { isSkillSourceRateLimitedRequest } from "@/api/handlers/skills/source-rate-limit";
import { smokeRoute } from "@/api/handlers/smoke/routes";
import { styleSetsRoute } from "@/api/handlers/style-sets/routes";
import { isStyleSetUploadRateLimitedRequest } from "@/api/handlers/style-sets/upload-rate-limit";
import { tasksRoute } from "@/api/handlers/tasks/routes";
import { templatePacksRoute } from "@/api/handlers/template-packs/routes";
import { templateRecipesRoute } from "@/api/handlers/template-recipes/routes";
import { clearLookupPreviewCache } from "@/api/handlers/templates/lookup-preview-cache";
import {
  templateCategoriesRoute,
  templatesRoute,
} from "@/api/handlers/templates/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { uploadsRoute } from "@/api/handlers/uploads/routes";
import { usageRoute } from "@/api/handlers/usage/routes";
import { userFilesRoute } from "@/api/handlers/user-files/routes";
import { verifyAuthRoute, verifyRoute } from "@/api/handlers/verify/routes";
import { viewTemplatesRoute } from "@/api/handlers/view-templates/routes";
import { viewsRoute } from "@/api/handlers/views/routes";
import { wellKnownRoute } from "@/api/handlers/well-known/routes";
import { myWorkRoute } from "@/api/handlers/work-obligations/my-work-route";
import { workObligationsRoute } from "@/api/handlers/work-obligations/routes";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { initAccountDeletionCleanupWorker } from "@/api/lib/account-deletion-cleanup-queue";
import { captureRequestError } from "@/api/lib/analytics/capture";
import { getAnalytics } from "@/api/lib/analytics/client";
import {
  getAuth,
  resolveUserRealtimeAuthorization,
  resolveWorkspaceRealtimeAudience,
} from "@/api/lib/auth";
import { initBilingualRunWorker } from "@/api/lib/bilingual/run-queue";
import { shouldRejectBrowserMutation } from "@/api/lib/browser-origin-guard";
import {
  resolveClientIp,
  resolveSignupRateLimitClientIp,
} from "@/api/lib/client-ip";
import {
  currentQueryCount,
  DB_QUERY_COUNT_HEADER,
} from "@/api/lib/db-query-counter";
import { assertConfiguredBetterAuthOAuthPolicy } from "@/api/lib/db/assert-better-auth-oauth-policy";
import { assertMigrationsApplied } from "@/api/lib/db/assert-migrations-applied";
import { detached } from "@/api/lib/detached";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { initDocumentDeadlineScoutWorker } from "@/api/lib/document-deadline-scout-worker";
import { initDocumentReviewRunWorker } from "@/api/lib/document-review/run-queue";
import { initDocumentTranslationRunWorker } from "@/api/lib/document-translation/run-queue";
import { initEntityDeletionCleanupWorker } from "@/api/lib/entity-deletion-cleanup-queue";
import { elysiaErrorAnswer } from "@/api/lib/errors/elysia-error";
import { httpError } from "@/api/lib/errors/http-error";
import { errorFingerprint, errorTag } from "@/api/lib/errors/utils";
import { initFileDerivativeWorker } from "@/api/lib/file-derivative-queue";
import { initFlowRunWorker } from "@/api/lib/flows/flow-run-worker";
import { markScheduledJobsReady } from "@/api/lib/health/readiness";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { FORMATTING_LOCALE_HEADER } from "@/api/lib/locale";
import { createMemoryPressureHandler } from "@/api/lib/memory-pressure";
import { multipartFormParser } from "@/api/lib/multipart-form-parser";
import {
  logger,
  type RequestErrorFingerprint,
} from "@/api/lib/observability/logger";
import {
  enrichRequestContext,
  getRequestContext,
  getRequestId,
  initRequestContext,
  isAiRequest,
  REQUEST_ID_HEADER,
} from "@/api/lib/observability/request-context";
import { emitRequestDurationMetric } from "@/api/lib/observability/request-metrics";
import { runWithRequestScope } from "@/api/lib/observability/request-scope";
import { resolveResponseStatus } from "@/api/lib/observability/response-status";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  isCorpusS3Stale,
  isS3Stale,
  refreshCorpusS3,
  refreshS3,
} from "@/api/lib/s3";
import { ensureDefaultSchedulerJobs } from "@/api/lib/scheduler/jobs";
import { startSchedulerLoop } from "@/api/lib/scheduler/runner";
import { securityCanaryInterceptor } from "@/api/lib/security-canary";
import { setSecurityHeaders } from "@/api/lib/security-headers";
import { startSse, stopSse } from "@/api/lib/sse";
import { initStyleSetPackageCleanupWorker } from "@/api/lib/style-set-package-cleanup-queue";
import { clearByokAdapterCache } from "@/api/lib/tanstack-ai-models";
import { isUploadRateLimitedPath } from "@/api/lib/upload-rate-limit";
import { initWorkflowWorkers } from "@/api/lib/workflow-queue";

const HEALTH_PATHS = new Set(["/health", "/live", "/ready", "/started"]);
const DEFAULT_API_PORT = 3001;
// Keep-alive idle timeout in seconds; see the `api.listen` call.
const HTTP_IDLE_TIMEOUT_S = 75;
// Emit the per-request query count in local/CI runs only, so the e2e guard
// can assert per-route budgets without deployed environments paying any
// per-query cost. Must match the logger gate in db/root.ts.
const DB_QUERY_COUNTER_ENABLED = env.isDev;
const SESSION_ID_HEADER = "x-posthog-session-id";
const TANSTACK_RUN_ID_HEADER = "X-Run-Id";
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[\w-]+$/u;
const S3_REFRESH_CHECK_INTERVAL_MS = 60_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

const getApiPort = () => {
  const rawPort = env.STELLA_API_PORT ?? env.PORT;
  if (!rawPort) {
    return DEFAULT_API_PORT;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return DEFAULT_API_PORT;
  }

  return parsedPort;
};

const startMemoryPressureHandler = () => {
  process.on(
    "memoryPressure",
    createMemoryPressureHandler({
      caches: [
        { clear: clearLookupPreviewCache },
        { clear: clearByokAdapterCache },
      ],
      onEviction: ({ evictedEntries, level }) => {
        logger.warn("runtime.memory_pressure", {
          "cache.evicted_entries": evictedEntries,
          "memory.pressure_level": level,
        });
      },
    }),
  );
};

const getRequestPath = (request: Request): string =>
  new URL(request.url).pathname;

// Stamp the per-request query count onto the outgoing response. Reads the
// active counter store, so it is a no-op when the store was never started
// (production, or a request that bypassed `onRequest`).
const setDbQueryCountHeader = (set: Context["set"]) => {
  if (!DB_QUERY_COUNTER_ENABLED) {
    return;
  }
  const queryCount = currentQueryCount();
  if (queryCount === undefined) {
    return;
  }
  set.headers[DB_QUERY_COUNT_HEADER] = String(queryCount);
};

const shouldLogRequest = (path: string): boolean => !HEALTH_PATHS.has(path);

const allowedBrowserOrigins = (): (string | RegExp)[] => {
  const origins: (string | RegExp)[] = frontendOrigins({
    frontendUrl: env.FRONTEND_URL,
    isDev: env.isDev,
  });
  if (env.isDev) {
    origins.push(/^chrome-extension:\/\//u);
    origins.push(...DEV_INSPECTOR_ORIGINS);
  }
  if (env.EXTENSION_ORIGIN) {
    origins.push(env.EXTENSION_ORIGIN);
  }
  return origins;
};

const ALLOWED_BROWSER_ORIGINS = allowedBrowserOrigins();

const getRouteName = (route: string | undefined): string =>
  route ?? "unmatched";

const buildRequestErrorFingerprint = (
  error: unknown,
): RequestErrorFingerprint => {
  const fingerprint = errorFingerprint(error);
  return {
    errorCauseFrame: fingerprint["error.cause.frame"],
    errorClass: fingerprint["error.class"],
    errorCode: fingerprint["error.code"],
    errorFrame: fingerprint["error.frame"],
    pgCode: fingerprint["error.cause.pg_code"],
    pgColumn: fingerprint["error.cause.pg_column"],
    pgConstraint: fingerprint["error.cause.pg_constraint"],
    pgRoutine: fingerprint["error.cause.pg_routine"],
    pgSchema: fingerprint["error.cause.pg_schema"],
    pgSeverity: fingerprint["error.cause.pg_severity"],
    pgTable: fingerprint["error.cause.pg_table"],
  };
};

const buildRequestLogDetails = ({
  durationMs,
  errorType,
  request,
  route,
  statusCode,
  reqCtx,
  elysiaCode,
}: {
  durationMs: number;
  errorType?: string;
  request: Request;
  route?: string;
  statusCode: number;
  reqCtx?: ReturnType<typeof getRequestContext>;
  elysiaCode?: string;
}) => {
  const details = {
    durationMs: Math.round(durationMs),
    method: request.method,
    route,
    statusCode,
  };

  if (elysiaCode) {
    Object.assign(details, { elysiaCode });
  }

  if (errorType) {
    Object.assign(details, { errorType });
  }

  if (reqCtx?.requestId) {
    Object.assign(details, { requestId: reqCtx.requestId });
  }

  return details;
};

const CORS_PREFLIGHT_MAX_AGE_SECONDS = 60 * 60;

const api = new Elysia()
  // Body parsing is decided before any route runs, so the multipart parser has
  // to sit ahead of every route registration.
  .use(multipartFormParser)
  .onRequest(async (context) => {
    const { request, set } = context;

    setSecurityHeaders(set);

    const rawSessionId = request.headers.get(SESSION_ID_HEADER);
    const sessionId =
      rawSessionId &&
      rawSessionId.length <= SESSION_ID_MAX_LENGTH &&
      SESSION_ID_PATTERN.test(rawSessionId)
        ? rawSessionId
        : undefined;

    initRequestContext(request, sessionId);
    enrichRequestContext(request, {
      clientIp: resolveClientIp(request, context.server ?? null),
      signupRateLimitIp: resolveSignupRateLimitClientIp(
        request,
        context.server ?? null,
      ),
    });

    // Stamp the receipt on every response from the central header point, next
    // to the security headers, so REST callers always get an `x-request-id`
    // they can quote back (the MCP envelope + invoke payloads carry the same id
    // through the ambient store). Set in `onRequest` so it survives error
    // responses too, exactly like `setSecurityHeaders`.
    const requestId = getRequestId(request);
    if (requestId !== undefined) {
      set.headers[REQUEST_ID_HEADER] = requestId;
    }

    if (
      shouldRejectBrowserMutation({
        allowedOrigins: ALLOWED_BROWSER_ORIGINS,
        method: request.method,
        origin: request.headers.get("origin"),
        secFetchSite: request.headers.get("sec-fetch-site"),
      })
    ) {
      set.status = 403;
      return httpError("Untrusted browser origin");
    }

    const interceptedResponse = await securityCanaryInterceptor(context);
    if (interceptedResponse) {
      return interceptedResponse;
    }

    // Ahead of the CORS layer below, which otherwise answers every preflight
    // with the API-wide method list and leaves the MCP route's own preflight
    // unreachable.
    const mcpPreflightResponse = handleMcpPreflightRequest(request, set);
    if (mcpPreflightResponse) {
      return mcpPreflightResponse;
    }

    return handleMcpAppSandboxRequest(request, set);
  })
  .use(
    cors({
      origin: ALLOWED_BROWSER_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "MCP-Protocol-Version",
        FORMATTING_LOCALE_HEADER,
        SESSION_ID_HEADER,
        TANSTACK_RUN_ID_HEADER,
      ],
      exposeHeaders: [
        "set-auth-token",
        "Content-Disposition",
        "X-Ai-Field-Errors",
        REQUEST_ID_HEADER,
      ],
      maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    }),
  )
  .onError(({ error, set, code, request, route }) => {
    delete set.headers["X-Powered-By"];
    setDbQueryCountHeader(set);

    const path = getRequestPath(request);
    const reqCtx = getRequestContext(request);
    const { status: statusCode, message: errorMessage } = elysiaErrorAnswer(
      code,
      error,
    );

    if (shouldLogRequest(path)) {
      const durationMs = reqCtx ? performance.now() - reqCtx.startTime : 0;
      const details = buildRequestLogDetails({
        durationMs,
        errorType: errorTag(error),
        request,
        route,
        statusCode,
        reqCtx,
        elysiaCode: String(code),
      });

      if (statusCode >= 500) {
        logger.request({
          ...details,
          errorFingerprint: buildRequestErrorFingerprint(error),
          message: "request.failed",
          severity: "ERROR",
        });
      } else {
        logger.request({
          ...details,
          message: "request.failed",
          severity: "WARN",
        });
      }

      emitRequestDurationMetric({
        durationMs,
        requestClass: isAiRequest() ? "ai" : "crud",
        statusCode,
        route: getRouteName(route),
      });
    }

    // A framework-answered client fault (a rejected body, an unknown route,
    // an unparseable request) is the caller's own outcome: the WARN record
    // above keeps it, and reporting it as an exception would fill the tracker
    // with one issue per scanner probe and schema mismatch. A response-schema
    // violation shares the VALIDATION code but is the handler's own fault, so
    // it stays captured along with every other code.
    if (statusCode >= 500) {
      captureRequestError(error, {
        request,
        context: {
          route: getRouteName(route),
          method: request.method,
          elysiaCode: String(code),
        },
      });
    }

    // Return a sanitized response for unhandled errors.
    // Elysia's default would serialize error.message, which
    // may contain DB internals, file names, or document content.
    set.status = statusCode;
    return httpError(errorMessage);
  })
  .onAfterHandle(async ({ request, responseValue, route, set }) => {
    delete set.headers["X-Powered-By"];
    setDbQueryCountHeader(set);

    const path = getRequestPath(request);
    const reqCtx = getRequestContext(request);

    if (shouldLogRequest(path) && reqCtx) {
      const durationMs = performance.now() - reqCtx.startTime;
      const statusCode = resolveResponseStatus({
        response: responseValue,
        set,
      });
      const details = buildRequestLogDetails({
        durationMs,
        request,
        route,
        statusCode,
        reqCtx,
      });

      if (statusCode >= 500) {
        logger.request({
          ...details,
          message: "request.completed",
          severity: "ERROR",
        });
      } else if (statusCode >= 400) {
        logger.request({
          ...details,
          message: "request.completed",
          severity: "WARN",
        });
      } else {
        logger.request({
          ...details,
          message: "request.completed",
          severity: "INFO",
        });
      }

      // Streaming responses (e.g. POST /v1/chat) settle this hook when the
      // stream object is returned, not when generation ends, so their
      // duration here understates the wall-clock. That is acceptable: the
      // class is `ai` either way, which is excluded from the CRUD p95 SLO.
      emitRequestDurationMetric({
        durationMs,
        requestClass: isAiRequest() ? "ai" : "crud",
        statusCode,
        route: getRouteName(route),
      });
    }

    if (!env.isDev && shouldLogRequest(path)) {
      const analytics = getAnalytics();
      await analytics.flush().catch((error: unknown) => {
        logger.error("analytics.flush.failed", {
          "error.type": errorTag(error),
          "http.route": getRouteName(route),
        });
      });
    }
  })
  .use(authUiRoute)
  .use(authMetadataRoute)
  .use(
    new Elysia()
      .use(
        rateLimit({
          duration: API_RATE_LIMITS.agentAuth.duration,
          max: API_RATE_LIMITS.agentAuth.max,
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "agent-auth",
          }),
        }),
      )
      .use(agentAuthRoute),
  )
  .use(
    // The session-authed confirm endpoint is mounted at the root (its path is
    // fixed, not `/v1`-prefixed), so it would otherwise escape the shared `api`
    // limiter. Give this mutating endpoint its own abuse budget.
    new Elysia()
      .use(
        rateLimit({
          duration: API_RATE_LIMITS.api.duration,
          max: API_RATE_LIMITS.api.max,
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "agent-auth-confirm",
          }),
          skip: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
        }),
      )
      .use(agentAuthConfirmRoute),
  )
  .use(healthRoute)
  .use(wellKnownRoute)
  .use(verifyRoute)
  .use(hostedUsageWebhookRoute)
  .use(
    // The MCP transport paths sit at the root, outside the shared `/v1`
    // budget, and one agent loop can otherwise issue unbounded JSON-RPC calls.
    // The address budget runs first so rotating bearer values cannot dodge
    // the credential budget. Each limiter's own `skip` keeps discovery and
    // preflight unmetered.
    new Elysia()
      .use(rateLimit(createMcpTransportAddressRateLimitOptions()))
      .use(rateLimit(createMcpTransportRateLimitOptions()))
      .use(mcpRoute),
  )
  .use(aiAutocompleteRoute)
  .use(feedbackPublicRoute)
  .use(memoriesRoute)
  .use(notificationsRoute)
  .use(devPublicRoute)
  .use(smokeRoute)
  .use(operatorRoute)
  .mount(getAuth().handler)
  .group(STELLA_API_VERSION_PREFIX, (app) =>
    app

      .use(
        rateLimit({
          duration: API_RATE_LIMITS.api.duration,
          max: API_RATE_LIMITS.api.max,
          ...createRedisRateLimit({
            failurePolicy: "fail_open_local",
            scope: "api",
          }),
          skip: (req) => {
            // The e2e route walk fires hundreds of /v1 requests per minute
            // from one IP; abuse limits are not what those runs measure. The
            // flag is dev-only by env validation and CI's e2e job already
            // sets it for the API it boots.
            if (env.E2E_DISABLE_AUTH_RATE_LIMIT) {
              return true;
            }
            // Endpoints with a dedicated rate-limit budget are excluded
            // from the shared `api` bucket so unrelated `/v1` traffic on
            // the same IP cannot drain their quota (see `upload` and
            // `folioCollab` in API_RATE_LIMITS). Each path is matched by
            // its canonical helper so this skip stays in lockstep with
            // the dedicated limiter that owns it.
            const { pathname } = new URL(req.url);
            return (
              isUploadRateLimitedPath(pathname) ||
              isFolioCollabRateLimitedPath(pathname) ||
              isSkillSourceRateLimitedRequest(req) ||
              isStyleSetUploadRateLimitedRequest(req)
            );
          },
        }),
      )
      .use(authCapabilitiesRoute)
      .use(workspaceEventsRoute)
      .use(workspacesRoute)
      .use(playbooksRoute)
      .use(playbookRunsRoute)
      .use(documentReviewsRoute)
      .use(documentReviewPassagesRoute)
      .use(documentTranslationsRoute)
      .use(bilingualTranslationsRoute)
      .use(reportsRoute)
      .use(flowsRoute)
      .use(signalsRoute)
      .use(flowRunsRoute)
      .use(documentTypesRoute)
      .use(propertiesRoute)
      .use(filesRoute)
      .use(
        new Elysia()
          .use(
            rateLimit({
              duration: API_RATE_LIMITS.folioCollab.duration,
              max: API_RATE_LIMITS.folioCollab.max,
              ...createRedisRateLimit({
                failurePolicy: "fail_open_local",
                scope: "folio-collab",
              }),
              // Same e2e escape hatch as the shared `api` bucket above: the
              // route walk opens the document editor repeatedly and would
              // drain this 30/min budget across back-to-back runs.
              skip: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
            }),
          )
          .use(folioCollabRoute),
      )
      .use(desktopEditSessionsRoute)
      .use(uploadsRoute)
      .use(entitiesRoute)
      .use(docxSuggestionsRoute)
      .use(fieldsRoute)
      .use(templatesRoute)
      .use(styleSetsRoute)
      .use(templateCategoriesRoute)
      .use(templatePacksRoute)
      .use(templateRecipesRoute)
      .use(timeEntriesRoute)
      .use(billingCodesRoute)
      .use(ratesRoute)
      .use(expensesRoute)
      .use(invoicesRoute)
      .use(externalPreviewRoute)
      .use(mcpConnectorsRoute)
      .use(sharepointRoute)
      .use(catalogueRoute)
      .use(organizationSettingsRoute)
      .use(apiKeysRoute)
      .use(aiConfigPublicRoute)
      .use(clauseCategoriesRoute)
      .use(clausesRoute)
      .use(contactsRoute)
      .use(legislationRoute)
      .use(legislationCorpusRoute)
      .use(publicLegislationRoute)
      .use(searchRoute)
      .use(savedSearchesRoute)
      .use(auditLogsRoute)
      .use(caseLawRoute)
      .use(chatRoute)
      .use(userFilesRoute)
      .use(skillsRoute)
      .use(usageRoute)
      .use(viewTemplatesRoute)
      .use(viewsRoute)
      .use(listsRoute)
      .use(tasksRoute)
      .use(workObligationsRoute)
      .use(myWorkRoute)
      .use(meRoute)
      .use(devRoute)
      .use(verifyAuthRoute),
  );

export default api;

// Scope the per-request async stores — the ambient request id and the dev/CI
// DB query counter — around the whole composed handler.
//
// No lifecycle hook can do this: a hook runs *inside* the request, so both
// stores used to open themselves from `onRequest` with
// `AsyncLocalStorage.enterWith`. `enterWith` mutates the ambient async context
// frame with no restore point, and the runtime leaves that frame current for
// callbacks it dispatches afterwards, so a background loop (a BullMQ worker, a
// reconciler tick, the SSE keep-alive) resuming there adopted the in-flight
// request's stores and kept them from then on — billing its own queries to that
// request's `x-db-queries` count and stamping that request's receipt id on
// unrelated work. `run` restores the previous frame, so the scope covers the
// request's own callback tree and nothing else.
//
// `wrap` is the only place that sees a whole request as one function: Elysia
// applies it to both the general handler and the per-route handlers it hands to
// Bun's native router, which `api.fetch` alone would miss. It is a private
// Elysia API, so pin its two observable effects rather than trusting it: the
// `x-request-id` header and the `x-db-queries` count both disappear if a future
// release stops applying higher-order functions, and the route-smoke network
// baseline fails on a budgeted endpoint whose response drops the count header.
const scopeRequestAsyncStores = (): void => {
  api.wrap(
    (handleRequest) => (request: Request) =>
      runWithRequestScope(() => handleRequest(request)),
  );
};

const startS3RefreshLoop = () => {
  const timer = setInterval(() => {
    if (isS3Stale()) {
      refreshS3().catch((error: unknown) => {
        logger.error("s3.refresh_failed", {
          "error.type": errorTag(error),
        });
      });
    }

    if (isCorpusS3Stale()) {
      refreshCorpusS3().catch((error: unknown) => {
        logger.error("s3.corpus_refresh_failed", {
          "error.type": errorTag(error),
        });
      });
    }
  }, S3_REFRESH_CHECK_INTERVAL_MS);

  timer.unref();
};

// Booting (migration check, S3 warmup, BullMQ workers, bound port) runs
// only when this module is the process entry point: `bun src/server.ts` in
// dev and the `bun build --compile` binary in prod. Importing the module
// instead — as the exact-mirror CI guard in
// `apps/api/scripts/exact-mirror-guard.ts` does to build every route's
// schema mirror — must yield the fully constructed `api` without any of
// these side effects (no DB, no Redis, no listen).
const startServer = async (): Promise<void> => {
  startMemoryPressureHandler();

  // Start the SSE keep-alive heartbeat and cross-instance Redis subscriber
  // first, before any awaited setup below, so its connection timing
  // matches the previous import-time behavior and completes well before
  // `api.listen()` starts accepting requests.
  startSse({
    user: resolveUserRealtimeAuthorization,
    workspace: resolveWorkspaceRealtimeAudience,
  });

  // Schema-drift fail-fast. If the runtime expects migrations
  // the database has not received, exit before serving any
  // request against a stale schema.
  await assertMigrationsApplied();

  // The OAuth resource backfill is deployment-owned rather than a committed
  // migration. Refuse readiness when it was skipped or only partially ran;
  // otherwise agent authorization would fail on first use after deployment.
  await assertConfiguredBetterAuthOAuthPolicy();

  await Promise.all([refreshS3(), refreshCorpusS3()]);
  startS3RefreshLoop();

  // Config fail-fast: an invalid bundled or runtime report spec must stop the
  // boot, not fail the first export that picks it. After the S3 refresh so a
  // REPORT_SPECS_S3_PREFIX read uses resolved credentials.
  await initBuiltinReportTemplates();

  // BullMQ worker for asynchronous file derivatives.
  const fileDerivativeWorker = initFileDerivativeWorker();

  // BullMQ workflow worker for AI extraction.
  const workflowWorkers = initWorkflowWorkers();

  // BullMQ worker for the Workflows (flow run) engine.
  const flowRunWorker = initFlowRunWorker();

  // BullMQ worker for durable account-deletion storage cleanup.
  const accountDeletionCleanupWorker = initAccountDeletionCleanupWorker();

  // BullMQ worker for durable storage cleanup after entity deletion commits.
  const entityDeletionCleanupWorker = initEntityDeletionCleanupWorker();

  // BullMQ worker for style set packages retained past download URL expiry.
  const styleSetPackageCleanupWorker = initStyleSetPackageCleanupWorker();

  // BullMQ worker for queued view→report exports.
  const reportExportWorker = initReportExportWorker();

  // BullMQ worker for durable document review runs.
  const documentReviewRunWorker = initDocumentReviewRunWorker();

  // BullMQ worker for unified document translation runs.
  const documentTranslationRunWorker = initDocumentTranslationRunWorker();

  // BullMQ worker for durable post-processing deadline scouts.
  const documentDeadlineScoutWorker = initDocumentDeadlineScoutWorker();

  // BullMQ worker for durable bilingual translation runs.
  const bilingualRunWorker = initBilingualRunWorker();

  scopeRequestAsyncStores();

  api.listen({
    port: getApiPort(),
    // Longer than the load balancer's 60 s idle timeout (Bun defaults to
    // 10 s). The balancer may reuse an idle backend connection any time
    // before its own timeout expires, so the server must never close
    // first: a request written onto a connection the server is closing is
    // lost in flight and the client hangs with no response and no
    // server-side log line. The SSE keep-alive heartbeat (20 s) stays
    // well inside this window.
    idleTimeout: HTTP_IDLE_TIMEOUT_S,
  });

  // Filled in after the handlers below are attached, so a signal arriving
  // during scheduler registration still finds a shutdown path. A holder rather
  // than a binding because the shutdown closure is created before the loop
  // exists and has to observe it once it does.
  const scheduler: { loop?: ReturnType<typeof startSchedulerLoop> } = {};

  // Graceful shutdown: stop accepting HTTP requests, then drain the BullMQ
  // workers on SIGTERM/SIGINT (deploy, container stop, or a local
  // `bun --watch` restart) so an in-flight job is not abandoned mid-write.
  // An abandoned job strands its workflow lock and leaves cells stuck
  // `pending` until the next boot reconciles them; draining avoids creating
  // that orphan in the common case. Worker draining is bounded so a slow job
  // can't hang shutdown; anything still in flight past the timeout is
  // reclaimed by the next boot's reconciler.
  let shuttingDown = false;
  const shutdownWorkers = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("api.shutdown_started", { signal });
    await api.stop().catch((error: unknown) => {
      logger.error("api.stop_failed", {
        "error.type": errorTag(error),
      });
    });
    stopSse();
    // Stop claiming new jobs before draining, so a tick in flight finishes
    // and releases its lease rather than leaving it to expire. Undefined when
    // the signal beat registration; there is nothing claimed to drain.
    scheduler.loop?.stop();
    await Promise.race([
      Promise.allSettled([
        scheduler.loop?.drained,
        workflowWorkers.close(),
        flowRunWorker.close(),
        fileDerivativeWorker.close(),
        accountDeletionCleanupWorker.close(),
        entityDeletionCleanupWorker.close(),
        styleSetPackageCleanupWorker.close(),
        reportExportWorker.close(),
        documentReviewRunWorker.close(),
        documentTranslationRunWorker.close(),
        documentDeadlineScoutWorker.close(),
        bilingualRunWorker.close(),
      ]),
      Bun.sleep(WORKER_SHUTDOWN_TIMEOUT_MS),
    ]);
    logger.info("api.shutdown_complete", { signal });
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    detached(shutdownWorkers("SIGTERM"), "server.shutdown");
  });
  process.once("SIGINT", () => {
    detached(shutdownWorkers("SIGINT"), "server.shutdown");
  });

  // Scheduled jobs run here rather than in a process of their own. A separate
  // deployment unit has to be remembered, and when it is forgotten nothing
  // says so: the jobs simply never run, which is indistinguishable from having
  // no work to do. Hosting the loop in a service that must exist for the
  // product to work at all removes that failure mode instead of monitoring it.
  // Each job is leased individually (`locked_by`/`locked_until`), so running
  // this in every replica is safe.
  //
  // Last on purpose. After `listen`, so liveness can distinguish slow setup
  // from a dead process; readiness remains false until registration completes.
  // After the signal handlers, because registration is awaited,
  // and a deploy landing inside that window would otherwise find no shutdown
  // path for the SSE loop, the S3 refresh loop and the listening socket.
  await ensureDefaultSchedulerJobs();
  scheduler.loop = startSchedulerLoop();
  markScheduledJobsReady();
  logger.info("scheduler.started", {
    "scheduler.runner_id": scheduler.loop.runnerId,
  });
};

if (import.meta.main) {
  await startServer();
}
