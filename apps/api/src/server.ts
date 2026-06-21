import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import type { Context } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import { env } from "@/api/env";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { aiAutocompleteRoute } from "@/api/handlers/ai-autocomplete/routes";
import { aiConfigPublicRoute } from "@/api/handlers/ai-config/routes";
import { auditLogsRoute } from "@/api/handlers/audit-logs/routes";
import {
  authCapabilitiesRoute,
  authMetadataRoute,
} from "@/api/handlers/auth/routes";
import { authUiRoute } from "@/api/handlers/auth/ui-routes";
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
import { documentTypesRoute } from "@/api/handlers/document-types/routes";
import { docxSuggestionsRoute } from "@/api/handlers/docx-suggestions/routes";
import { desktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { isUploadRateLimitedPath } from "@/api/handlers/entities/upload-rate-limit";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { externalPreviewRoute } from "@/api/handlers/external-preview/routes";
import { feedbackPublicRoute } from "@/api/handlers/feedback/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { isFolioCollabRateLimitedPath } from "@/api/handlers/folio-collab/rate-limit";
import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { hostedUsageWebhookRoute } from "@/api/handlers/hosted-usage-webhook/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { legislationCorpusRoute } from "@/api/handlers/legislation/corpus-routes";
import { legislationRoute } from "@/api/handlers/legislation/routes";
import { mcpConnectorsRoute } from "@/api/handlers/mcp-connectors/routes";
import { mcpRoute } from "@/api/handlers/mcp/routes";
import { meRoute } from "@/api/handlers/me/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { playbooksRoute } from "@/api/handlers/playbooks/routes";
import { playbookRunsRoute } from "@/api/handlers/playbooks/run-route";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { initReportExportWorker } from "@/api/handlers/reports/report-export-queue";
import { reportsRoute } from "@/api/handlers/reports/routes";
import { searchRoute } from "@/api/handlers/search/routes";
import { skillsRoute } from "@/api/handlers/skills/routes";
import { smokeRoute } from "@/api/handlers/smoke/routes";
import { styleSetsRoute } from "@/api/handlers/style-sets/routes";
import { isStyleSetUploadRateLimitedRequest } from "@/api/handlers/style-sets/upload-rate-limit";
import { myTasksRoute } from "@/api/handlers/tasks/my-tasks-route";
import { tasksRoute } from "@/api/handlers/tasks/routes";
import { templateRecipesRoute } from "@/api/handlers/template-recipes/routes";
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
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { initAccountDeletionCleanupWorker } from "@/api/lib/account-deletion-cleanup-queue";
import { captureRequestError } from "@/api/lib/analytics/capture";
import { getAnalytics } from "@/api/lib/analytics/client";
import { getAuth } from "@/api/lib/auth";
import {
  beginRequestQueryCounter,
  currentQueryCount,
  DB_QUERY_COUNT_HEADER,
} from "@/api/lib/db-query-counter";
import { assertMigrationsApplied } from "@/api/lib/db/assert-migrations-applied";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { httpError } from "@/api/lib/errors/http-error";
import {
  errorFingerprint,
  errorTag,
  unredactedErrorFields,
} from "@/api/lib/errors/utils";
import { initFileDerivativeWorker } from "@/api/lib/file-derivative-queue";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { FORMATTING_LOCALE_HEADER } from "@/api/lib/locale";
import { logger } from "@/api/lib/observability/logger";
import {
  getRequestContext,
  getRequestId,
  initRequestContext,
  REQUEST_ID_HEADER,
} from "@/api/lib/observability/request-context";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  isCorpusS3Stale,
  isS3Stale,
  refreshCorpusS3,
  refreshS3,
} from "@/api/lib/s3";
import { setSecurityHeaders } from "@/api/lib/security-headers";
import { startSse, stopSse } from "@/api/lib/sse";
import { initStyleSetPackageCleanupWorker } from "@/api/lib/style-set-package-cleanup-queue";
import { initWorkflowWorkers } from "@/api/lib/workflow-queue";

const HEALTH_PATH = "/health";
const DEFAULT_API_PORT = 3001;
// Emit the per-request query count in local/CI runs only, so the e2e guard
// can assert per-route budgets without deployed environments paying any
// per-query cost. Must match the logger gate in db/root.ts.
const DB_QUERY_COUNTER_ENABLED = env.isDev;
const SESSION_ID_HEADER = "x-posthog-session-id";
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[\w-]+$/u;
const S3_REFRESH_CHECK_INTERVAL_MS = 60_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

const STATUS_BY_ELYSIA_CODE: Partial<Record<string, number>> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  PARSE: 400,
};

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

const shouldLogRequest = (path: string): boolean => path !== HEALTH_PATH;

const getRouteName = ({
  path,
  route,
}: {
  path: string;
  route: string | undefined;
}): string => route ?? path;

const buildRequestLogAttributes = ({
  durationMs,
  errorType,
  path,
  request,
  route,
  statusCode,
  reqCtx,
  elysiaCode,
}: {
  durationMs: number;
  errorType?: string;
  path: string;
  request: Request;
  route?: string;
  statusCode: number;
  reqCtx?: ReturnType<typeof getRequestContext>;
  elysiaCode?: string;
}) => {
  const attributes: Record<string, string | number | boolean> = {
    "http.method": request.method,
    "http.route": getRouteName({ path, route }),
    "http.status_code": statusCode,
    "request.duration_ms": Math.round(durationMs),
  };

  if (elysiaCode) {
    attributes["http.elysia_code"] = elysiaCode;
  }

  if (errorType) {
    attributes["error.type"] = errorType;
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

  return attributes;
};

const api = new Elysia()
  .onRequest(({ request, set }) => {
    // Start the per-request query counter before any handler (or better-auth
    // session lookup) can issue a query, so those queries are attributed to
    // this request. `enterWith` binds the store to this request's async
    // context; each request enters its own context, so counts do not leak.
    if (DB_QUERY_COUNTER_ENABLED) {
      beginRequestQueryCounter();
    }

    setSecurityHeaders(set);

    const rawSessionId = request.headers.get(SESSION_ID_HEADER);
    const sessionId =
      rawSessionId &&
      rawSessionId.length <= SESSION_ID_MAX_LENGTH &&
      SESSION_ID_PATTERN.test(rawSessionId)
        ? rawSessionId
        : undefined;

    initRequestContext(request, sessionId);

    // Stamp the receipt on every response from the central header point, next
    // to the security headers, so REST callers always get an `x-request-id`
    // they can quote back (the MCP envelope + invoke payloads carry the same id
    // through the ambient store). Set in `onRequest` so it survives error
    // responses too, exactly like `setSecurityHeaders`.
    const requestId = getRequestId(request);
    if (requestId !== undefined) {
      set.headers[REQUEST_ID_HEADER] = requestId;
    }
  })
  .use(
    cors({
      origin: (() => {
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
      })(),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "MCP-Protocol-Version",
        FORMATTING_LOCALE_HEADER,
        SESSION_ID_HEADER,
      ],
      exposeHeaders: [
        "set-auth-token",
        "Content-Disposition",
        REQUEST_ID_HEADER,
      ],
    }),
  )
  .onError(({ error, set, code, request, route }) => {
    delete set.headers["X-Powered-By"];
    setDbQueryCountHeader(set);

    const path = getRequestPath(request);
    const reqCtx = getRequestContext(request);
    const statusCode = STATUS_BY_ELYSIA_CODE[code] ?? 500;

    if (shouldLogRequest(path)) {
      const attributes = buildRequestLogAttributes({
        durationMs: reqCtx ? performance.now() - reqCtx.startTime : 0,
        errorType: errorTag(error),
        path,
        request,
        route,
        statusCode,
        reqCtx,
        elysiaCode: String(code),
      });

      if (statusCode >= 500) {
        Object.assign(attributes, errorFingerprint(error));
        if (env.isDev && env.DEBUG_UNREDACTED_ERRORS) {
          Object.assign(attributes, unredactedErrorFields(error));
        }
        logger.error("request.failed", attributes);
      } else {
        logger.warn("request.failed", attributes);
      }
    }

    captureRequestError(error, {
      request,
      context: {
        route: getRouteName({ path, route }),
        method: request.method,
        elysiaCode: String(code),
      },
    });

    // Return a sanitized response for unhandled errors.
    // Elysia's default would serialize error.message, which
    // may contain DB internals, file names, or document content.
    set.status = statusCode;
    if (code === "VALIDATION") {
      return httpError("Invalid request");
    }
    if (code === "NOT_FOUND") {
      return httpError("Not found");
    }
    if (code === "PARSE") {
      return httpError("Malformed request");
    }
    return httpError("Internal server error");
  })
  .onAfterHandle(async ({ request, route, set }) => {
    delete set.headers["X-Powered-By"];
    setDbQueryCountHeader(set);

    const path = getRequestPath(request);
    const reqCtx = getRequestContext(request);

    if (shouldLogRequest(path) && reqCtx) {
      const statusCode = typeof set.status === "number" ? set.status : 200;
      const attributes = buildRequestLogAttributes({
        durationMs: performance.now() - reqCtx.startTime,
        path,
        request,
        route,
        statusCode,
        reqCtx,
      });

      if (statusCode >= 500) {
        logger.error("request.completed", attributes);
      } else if (statusCode >= 400) {
        logger.warn("request.completed", attributes);
      } else {
        logger.info("request.completed", attributes);
      }
    }

    if (!env.isDev && shouldLogRequest(path)) {
      const analytics = getAnalytics();
      await analytics.flush().catch((error: unknown) => {
        logger.error("analytics.flush.failed", {
          "error.type": errorTag(error),
          "http.route": getRouteName({ path, route }),
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
          scoping: "scoped",
          duration: API_RATE_LIMITS.agentAuth.duration,
          max: API_RATE_LIMITS.agentAuth.max,
          generator: scopedGenerator("agent-auth"),
          context: new InMemoryRateLimitContext(),
        }),
      )
      .use(agentAuthRoute),
  )
  .use(agentAuthConfirmRoute)
  .use(healthRoute)
  .use(verifyRoute)
  .use(hostedUsageWebhookRoute)
  .use(mcpRoute)
  .use(aiAutocompleteRoute)
  .use(feedbackPublicRoute)
  .use(devPublicRoute)
  .use(smokeRoute)
  .mount(getAuth().handler)
  .group("/v1", (app) =>
    app

      .use(
        rateLimit({
          scoping: "scoped",
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
      .use(reportsRoute)
      .use(documentTypesRoute)
      .use(propertiesRoute)
      .use(filesRoute)
      .use(
        new Elysia()
          .use(
            rateLimit({
              scoping: "scoped",
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
      .use(templateRecipesRoute)
      .use(timeEntriesRoute)
      .use(billingCodesRoute)
      .use(ratesRoute)
      .use(expensesRoute)
      .use(invoicesRoute)
      .use(externalPreviewRoute)
      .use(mcpConnectorsRoute)
      .use(catalogueRoute)
      .use(organizationSettingsRoute)
      .use(aiConfigPublicRoute)
      .use(clauseCategoriesRoute)
      .use(clausesRoute)
      .use(contactsRoute)
      .use(legislationRoute)
      .use(legislationCorpusRoute)
      .use(searchRoute)
      .use(auditLogsRoute)
      .use(caseLawRoute)
      .use(chatRoute)
      .use(userFilesRoute)
      .use(skillsRoute)
      .use(usageRoute)
      .use(viewTemplatesRoute)
      .use(viewsRoute)
      .use(tasksRoute)
      .use(myTasksRoute)
      .use(meRoute)
      .use(devRoute)
      .use(verifyAuthRoute),
  );

export default api;

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
  // Start the SSE keep-alive heartbeat and cross-instance Redis subscriber
  // first, before any awaited setup below, so its connection timing
  // matches the previous import-time behavior and completes well before
  // `api.listen()` starts accepting requests.
  startSse();

  // Schema-drift fail-fast. If the runtime expects migrations
  // the database has not received, exit before serving any
  // request against a stale schema.
  await assertMigrationsApplied();

  await Promise.all([refreshS3(), refreshCorpusS3()]);
  startS3RefreshLoop();

  // BullMQ worker for asynchronous file derivatives.
  const fileDerivativeWorker = initFileDerivativeWorker();

  // BullMQ workflow worker for AI extraction.
  const workflowWorkers = initWorkflowWorkers();

  // BullMQ worker for durable account-deletion storage cleanup.
  const accountDeletionCleanupWorker = initAccountDeletionCleanupWorker();

  // BullMQ worker for style set packages retained past download URL expiry.
  const styleSetPackageCleanupWorker = initStyleSetPackageCleanupWorker();

  // BullMQ worker for queued view→report exports.
  const reportExportWorker = initReportExportWorker();

  api.listen(getApiPort());

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
    await Promise.race([
      Promise.allSettled([
        workflowWorkers.close(),
        fileDerivativeWorker.close(),
        accountDeletionCleanupWorker.close(),
        styleSetPackageCleanupWorker.close(),
        reportExportWorker.close(),
      ]),
      Bun.sleep(WORKER_SHUTDOWN_TIMEOUT_MS),
    ]);
    logger.info("api.shutdown_complete", { signal });
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdownWorkers("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdownWorkers("SIGINT");
  });
};

if (import.meta.main) {
  await startServer();
}
