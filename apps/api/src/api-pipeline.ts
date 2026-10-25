import { REQUEST_ID_HEADER } from "@stll/api-contract";
import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { AUTH_SESSION_STARTUP_HEADER } from "@stll/auth-model";

import { env } from "@/api/env";
import { mcpTransportMethodRefusal } from "@/api/handlers/mcp/routes-core";
import { responseCachePolicy } from "@/api/http/cache";
import { cors } from "@/api/http/cors";
import { setResponseHeaders } from "@/api/http/headers";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  isAllowedBrowserOrigin,
  shouldRejectBrowserMutation,
} from "@/api/lib/browser-origin-guard";
import { capabilityRequestGuard } from "@/api/lib/capability-request";
import { loadCapabilityEndpoints } from "@/api/lib/capability-request-endpoints";
import {
  resolveClientAddress,
  resolveSignupRateLimitClientIp,
  sealEdgeHeaders,
  socketPeerOnce,
  stampClientAddressHeader,
} from "@/api/lib/client-ip";
import { DEV_INSPECTOR_ORIGINS, frontendOrigins } from "@/api/lib/dev-origins";
import { httpError } from "@/api/lib/errors/http-error";
import { FORMATTING_LOCALE_HEADER } from "@/api/lib/locale";
import {
  clientTooOldError,
  LOCAL_CLIENT_IDENTITY_HEADER,
} from "@/api/lib/mcp-connectors/local-client-support";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import {
  enrichRequestContext,
  getRequestId,
  openRequestContext,
  recordRequestExceptionScope,
} from "@/api/lib/observability/request-context";
import {
  errorBoundary,
  requestCompletion,
} from "@/api/lib/observability/request-lifecycle";
import { runWithHttpRequestScope } from "@/api/lib/observability/request-scope";
import { tenantActionAdmission } from "@/api/lib/rate-limit/tenant-action-boundary";
import { securityCanary } from "@/api/lib/security-canary";
import {
  CORS_EXPOSED_HEADERS,
  securityHeaders,
} from "@/api/lib/security-headers";
import { isLocalDevOpen, runtimeMode } from "@/api/runtime-mode";

const SESSION_ID_HEADER = "x-posthog-session-id";
const TANSTACK_RUN_ID_HEADER = "X-Run-Id";
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[\w-]+$/u;
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 60 * 60;

const allowedBrowserOrigins = (): (string | RegExp)[] => {
  const origins: (string | RegExp)[] = frontendOrigins({
    frontendUrl: env.FRONTEND_URL,
    runtimeMode: runtimeMode(),
  });
  if (isLocalDevOpen()) {
    origins.push(/^chrome-extension:\/\//u);
    origins.push(...DEV_INSPECTOR_ORIGINS);
  }
  if (env.EXTENSION_ORIGIN) {
    origins.push(env.EXTENSION_ORIGIN);
  }
  return origins;
};

const ALLOWED_BROWSER_ORIGINS = allowedBrowserOrigins();

/**
 * The one async scope the request runs in: its receipt id and its database
 * query count. Opened with `run`, so nothing outside the request's own
 * callback tree adopts it.
 */
const requestScope: Middleware = async (ctx, inner) =>
  await runWithHttpRequestScope(async () => {
    const scope = {
      type: "request",
      method: ctx.request.method,
      routeTemplate: ctx.route ?? "unmatched",
    } as const;
    recordRequestExceptionScope(ctx.request, scope);
    return await withExceptionScope(scope, async () => await inner());
  });

/**
 * Who is calling and from where, resolved once while the edge headers are
 * present, and the receipt id every answer carries so a caller can quote it.
 */
const requestIdentity: Middleware = async ({ request, server }, inner) => {
  const rawSessionId = request.headers.get(SESSION_ID_HEADER);
  openRequestContext(
    rawSessionId !== null &&
      rawSessionId.length <= SESSION_ID_MAX_LENGTH &&
      SESSION_ID_PATTERN.test(rawSessionId)
      ? rawSessionId
      : undefined,
  );
  // Both addresses start from the socket peer, read from the socket once.
  const socket = socketPeerOnce(request, server ?? null);
  const clientAddress = resolveClientAddress(request, socket);
  // Better Auth reads the address from this header.
  stampClientAddressHeader(request, clientAddress);
  enrichRequestContext({
    clientIp: clientAddress?.address ?? null,
    clientAddressSource: clientAddress?.source ?? null,
    signupRateLimitIp: resolveSignupRateLimitClientIp(request, socket),
  });
  sealEdgeHeaders(request, clientAddress);

  const response = await inner();
  const requestId = getRequestId();
  return requestId === undefined
    ? response
    : setResponseHeaders(
        response,
        { [REQUEST_ID_HEADER]: requestId },
        { overwrite: true },
      );
};

/** A local client below its supported minimum is told to update. */
const clientTooOld: Middleware = async (ctx, inner) => {
  const error = clientTooOldError(ctx.request);
  return error === undefined
    ? await inner()
    : toResponse(status(426, error), ctx.set);
};

/** A browser mutation from an origin the app does not run on is refused. */
const browserOriginGuard: Middleware = async (ctx, inner) =>
  shouldRejectBrowserMutation({
    allowedOrigins: ALLOWED_BROWSER_ORIGINS,
    method: ctx.request.method,
    origin: ctx.request.headers.get("origin"),
    secFetchSite: ctx.request.headers.get("sec-fetch-site"),
  })
    ? toResponse(status(403, httpError("Untrusted browser origin")), ctx.set)
    : await inner();

/**
 * The stages every request passes through, outermost first. Each answer,
 * refusals and errors included, leaves through all the stages outside the one
 * that produced it: the error boundary sits inside CORS and the security
 * headers, so a failure is as readable and as protected as a success.
 */
export const apiPipeline: readonly Middleware[] = [
  requestScope,
  requestIdentity,
  requestCompletion,
  responseCachePolicy,
  securityHeaders,
  mcpTransportMethodRefusal,
  cors({
    isAllowedOrigin: (origin) =>
      isAllowedBrowserOrigin(origin, ALLOWED_BROWSER_ORIGINS),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      LOCAL_CLIENT_IDENTITY_HEADER,
      FORMATTING_LOCALE_HEADER,
      SESSION_ID_HEADER,
      AUTH_SESSION_STARTUP_HEADER,
      TANSTACK_RUN_ID_HEADER,
      CAPABILITY_REQUEST_HEADER,
    ],
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAgeSeconds: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  }),
  errorBoundary,
  clientTooOld,
  browserOriginGuard,
  securityCanary,
  tenantActionAdmission(),
  capabilityRequestGuard(loadCapabilityEndpoints),
];
