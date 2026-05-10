import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import { env } from "@/api/env";
import { aiConfigPublicRoute } from "@/api/handlers/ai-config/routes";
import { auditLogsRoute } from "@/api/handlers/audit-logs/routes";
import { authMetadataRoute } from "@/api/handlers/auth/routes";
import { authUiRoute } from "@/api/handlers/auth/ui-routes";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import {
  clauseCategoriesRoute,
  clausesRoute,
} from "@/api/handlers/clauses/routes";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { devPublicRoute, devRoute } from "@/api/handlers/dev/routes";
import { desktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { externalPreviewRoute } from "@/api/handlers/external-preview/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { legislationRoute } from "@/api/handlers/legislation/routes";
import { mcpConnectorsRoute } from "@/api/handlers/mcp-connectors/routes";
import { mcpRoute } from "@/api/handlers/mcp/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { searchRoute } from "@/api/handlers/search/routes";
import { shortcutsRoute } from "@/api/handlers/shortcuts/routes";
import { skillsRoute } from "@/api/handlers/skills/routes";
import { myTasksRoute } from "@/api/handlers/tasks/my-tasks-route";
import { tasksRoute } from "@/api/handlers/tasks/routes";
import {
  templateCategoriesRoute,
  templatesRoute,
} from "@/api/handlers/templates/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { userFilesRoute } from "@/api/handlers/user-files/routes";
import { verifyAuthRoute, verifyRoute } from "@/api/handlers/verify/routes";
import { viewsRoute } from "@/api/handlers/views/routes";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { captureRequestError, getAnalytics } from "@/api/lib/analytics";
import { getAuth } from "@/api/lib/auth";
import { assertMigrationsApplied } from "@/api/lib/db/assert-migrations-applied";
import { DEV_INSPECTOR_ORIGINS } from "@/api/lib/dev-origins";
import { httpError } from "@/api/lib/errors/http-error";
import { errorTag } from "@/api/lib/errors/utils";
import { initFileDerivativeWorker } from "@/api/lib/file-derivative-queue";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  getRequestContext,
  initRequestContext,
} from "@/api/lib/observability/request-context";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit";
import { isS3Stale, refreshS3 } from "@/api/lib/s3";
import { setSecurityHeaders } from "@/api/lib/security-headers";
import { initWorkflowWorker } from "@/api/lib/workflow-queue";

const HEALTH_PATH = "/health";
const DEFAULT_API_PORT = 3001;
const SESSION_ID_HEADER = "x-posthog-session-id";
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[\w-]+$/;
const S3_REFRESH_CHECK_INTERVAL_MS = 60_000;

const STATUS_BY_ELYSIA_CODE: Partial<Record<string, number>> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  PARSE: 400,
};

const getApiPort = () => {
  const rawPort = process.env["STELLA_API_PORT"];
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
    setSecurityHeaders(set);

    const rawSessionId = request.headers.get(SESSION_ID_HEADER);
    const sessionId =
      rawSessionId &&
      rawSessionId.length <= SESSION_ID_MAX_LENGTH &&
      SESSION_ID_PATTERN.test(rawSessionId)
        ? rawSessionId
        : undefined;

    initRequestContext(request, sessionId);
  })
  .use(
    cors({
      origin: (() => {
        const origins: (string | RegExp)[] = [env.FRONTEND_URL];
        if (env.isDev) {
          origins.push(/^chrome-extension:\/\//);
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
        SESSION_ID_HEADER,
      ],
      exposeHeaders: ["set-auth-token", "Content-Disposition"],
    }),
  )
  .onError(({ error, set, code, request, route }) => {
    delete set.headers["X-Powered-By"];

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
  .use(healthRoute)
  .use(verifyRoute)
  .use(mcpRoute)
  .use(devPublicRoute)
  .mount(getAuth().handler)
  .group("/v1", (app) =>
    app

      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.api.duration,
          max: API_RATE_LIMITS.api.max,
          generator: scopedGenerator("api"),
          context: new InMemoryRateLimitContext(),
          skip: (req) =>
            /\/entities\/[^/]+\/upload$/.test(new URL(req.url).pathname),
        }),
      )
      .use(workspaceEventsRoute)
      .use(workspacesRoute)
      .use(propertiesRoute)
      .use(filesRoute)
      .use(folioCollabRoute)
      .use(desktopEditSessionsRoute)
      .use(entitiesRoute)
      .use(fieldsRoute)
      .use(templatesRoute)
      .use(templateCategoriesRoute)
      .use(timeEntriesRoute)
      .use(billingCodesRoute)
      .use(ratesRoute)
      .use(expensesRoute)
      .use(invoicesRoute)
      .use(externalPreviewRoute)
      .use(mcpConnectorsRoute)
      .use(organizationSettingsRoute)
      .use(aiConfigPublicRoute)
      .use(clauseCategoriesRoute)
      .use(clausesRoute)
      .use(contactsRoute)
      .use(legislationRoute)
      .use(searchRoute)
      .use(auditLogsRoute)
      .use(caseLawRoute)
      .use(chatRoute)
      .use(userFilesRoute)
      .use(skillsRoute)
      .use(shortcutsRoute)
      .use(viewsRoute)
      .use(tasksRoute)
      .use(myTasksRoute)
      .use(devRoute)
      .use(verifyAuthRoute),
  );

export default api;

const startS3RefreshLoop = () => {
  const timer = setInterval(() => {
    if (!isS3Stale()) {
      return;
    }

    refreshS3().catch((error: unknown) => {
      logger.error("s3.refresh_failed", {
        "error.type": errorTag(error),
      });
    });
  }, S3_REFRESH_CHECK_INTERVAL_MS);

  timer.unref();
};

// Schema-drift fail-fast. If the runtime expects migrations
// the database has not received, exit before serving any
// request against a stale schema.
await assertMigrationsApplied();

await refreshS3();
startS3RefreshLoop();

// BullMQ worker for asynchronous file derivatives.
initFileDerivativeWorker();

// BullMQ workflow worker for AI extraction.
initWorkflowWorker();

api.listen(getApiPort());
