import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import { env } from "@/api/env";
import { analyticsRoute } from "@/api/handlers/analytics/routes";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import {
  clauseCategoriesRoute,
  clausesRoute,
} from "@/api/handlers/clauses/routes";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { devRoute } from "@/api/handlers/dev/routes";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { registry } from "@/api/handlers/registry";
import { searchRoute } from "@/api/handlers/search/routes";
import { myTasksRoute } from "@/api/handlers/tasks/my-tasks-route";
import { tasksRoute } from "@/api/handlers/tasks/routes";
import { templateAnalyticsRoute } from "@/api/handlers/template-analytics/routes";
import {
  templateCategoriesRoute,
  templatesRoute,
} from "@/api/handlers/templates/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { verifyAuthRoute, verifyRoute } from "@/api/handlers/verify/routes";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { captureError, getAnalytics } from "@/api/lib/analytics";
import { auth } from "@/api/lib/auth";
import { httpError } from "@/api/lib/errors/http-error";
import { errorTag } from "@/api/lib/errors/utils";
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
import { setSecurityHeaders } from "@/api/lib/security-headers";

// RivetKit manager runs on port 6420 with basePath /api/rivet.
// In production, ALB routes /api/rivet/* to port 6420 directly.
// In dev, the frontend connects to localhost:6420/api/rivet.
registry.startRunner();

const HEALTH_PATH = "/health";
const SESSION_ID_HEADER = "x-posthog-session-id";
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[\w-]+$/;

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
    attributes.posthogDistinctId = reqCtx.posthogDistinctId;
  }

  if (reqCtx?.sessionId) {
    attributes.sessionId = reqCtx.sessionId;
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
        }
        if (env.EXTENSION_ORIGIN) {
          origins.push(env.EXTENSION_ORIGIN);
        }
        return origins;
      })(),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", SESSION_ID_HEADER],
      exposeHeaders: ["set-auth-token"],
    }),
  )
  .onError(({ error, set, code, request, route }) => {
    delete set.headers["X-Powered-By"];

    const path = getRequestPath(request);
    const reqCtx = getRequestContext(request);
    const statusCode =
      code === "VALIDATION"
        ? 422
        : code === "NOT_FOUND"
          ? 404
          : code === "PARSE"
            ? 400
            : 500;

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

    captureError(error, {
      method: request.method,
      path,
      elysiaCode: String(code),
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
        // eslint-disable-next-line no-console
        console.error("Error flushing analytics", error);
      });
    }
  })
  .use(healthRoute)
  .use(verifyRoute)
  .mount(auth.handler)
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
      .use(workspacesRoute)
      .use(propertiesRoute)
      .use(filesRoute)
      .use(entitiesRoute)
      .use(fieldsRoute)
      .use(templatesRoute)
      .use(templateCategoriesRoute)
      .use(timeEntriesRoute)
      .use(billingCodesRoute)
      .use(ratesRoute)
      .use(expensesRoute)
      .use(invoicesRoute)
      .use(organizationSettingsRoute)
      .use(clauseCategoriesRoute)
      .use(clausesRoute)
      .use(contactsRoute)
      .use(searchRoute)
      .use(analyticsRoute)
      .use(templateAnalyticsRoute)
      .use(caseLawRoute)
      .use(chatRoute)
      .use(tasksRoute)
      .use(myTasksRoute)
      .use(devRoute)
      .use(verifyAuthRoute),
  );

export default api;

api.listen(3001);
