import type { Err, UnhandledException } from "better-result";
import { Result } from "better-result";
import type {
  Context,
  ElysiaCustomStatusResponse,
  InputSchema,
  UnwrapRoute,
} from "elysia";
import { status } from "elysia";

import type { PermissionInput } from "@stll/permissions";
import { roles } from "@stll/permissions";

import type { SafeDb, ScopedDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-models";
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
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { getRequestContext } from "@/api/lib/observability/request-context";

export type HandlerConfig = InputSchema & {
  permissions: PermissionInput;
};

export type SessionHandlerConfig = InputSchema;

type ConfigRouteSchema<TConfig extends HandlerConfig> = UnwrapRoute<
  Omit<TConfig, "permissions">
>;

type SessionConfigRouteSchema<TConfig extends SessionHandlerConfig> =
  UnwrapRoute<TConfig>;

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
    /**
     * Excludes workspaces being deleted. Includes active and
     * archived workspaces. Use for search, chat, MCP, and any
     * query that should not surface content from sealed workspaces.
     */
    activeWorkspaceIds: SafeId<"workspace">[];
    accessibleWorkspaces: AccessibleWorkspace[];
    memberRole: {
      role: keyof typeof roles;
    };
    orgAIConfig: OrgAIConfig | null;
    /**
     * Whether stella may annotate AI requests for this org with
     * prompt-cache markers. Threaded through to `getModelForRole`
     * and `getModelById`; the SDK middleware strips any markers when
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

type SafeErrorBody = { code?: HandlerErrorCode | undefined; message: string };

// The conditional form is intentional: it keeps status unions distributive so
// Eden sees distinct error codes instead of a single widened response.
type SafeStatusResponse<TStatusCode extends HandlerErrorStatusCode> =
  TStatusCode extends HandlerErrorStatusCode
    ? ElysiaCustomStatusResponse<TStatusCode, SafeErrorBody>
    : never;

type SafeHandlerResult<TResult> =
  | TResult
  | SafeStatusResponse<HandlerErrorStatusCode>;

type SafeHandlerFn<TContext, TResult> = (
  ctx: TContext,
) => AsyncGenerator<
  Err<never, SafeHandlerError>,
  Result<TResult, SafeHandlerError>,
  unknown
>;

type SafeHandlerDefinition<
  TConfig extends InputSchema = InputSchema,
  TContext = Context<UnwrapRoute<TConfig>>,
  TResult = unknown,
> = {
  config: TConfig;
  handler: (ctx: TContext) => Promise<SafeHandlerResult<TResult>>;
};

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

const runSafeHandler = async <TContext extends SafeHandlerLogContext, TResult>(
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

      return toSafeStatusResponse(400, { message: "Access denied" });
    }

    logAndCaptureSafeError({
      request: ctx.request,
      route: ctx.route,
      error,
      statusCode: 500,
    });

    return toSafeStatusResponse(500, { message: "Internal server error" });
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

    return toSafeStatusResponse(500, { message: "Internal server error" });
  }
};

const createSafeScopedHandler = <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult,
>(
  config: TConfig,
  handler: SafeHandlerFn<TContext, TResult>,
): SafeHandlerDefinition<TConfig, TContext, TResult> => ({
  config,
  handler: async (ctx): Promise<SafeHandlerResult<TResult>> => {
    const hasPermission = roles[ctx.memberRole.role].authorize(
      config.permissions,
    );

    if (!hasPermission.success) {
      return toSafeStatusResponse(403, { message: "Forbidden" });
    }

    return await runSafeHandler(ctx, handler);
  },
});

const createSafeDirectHandler = <
  TConfig extends InputSchema,
  TContext extends SafeHandlerLogContext,
  TResult,
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
});

export const createSafeRootHandler = <TConfig extends HandlerConfig, TResult>(
  config: TConfig,
  handler: SafeHandlerFn<RootHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, RootHandlerContext<TConfig>, TResult> =>
  createSafeScopedHandler(config, handler);

export const createSafeHandler = <TConfig extends HandlerConfig, TResult>(
  config: TConfig,
  handler: SafeHandlerFn<WorkspaceHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, WorkspaceHandlerContext<TConfig>, TResult> =>
  createSafeScopedHandler(config, handler);

export const createSafeSessionHandler = <
  TConfig extends SessionHandlerConfig,
  TResult,
>(
  config: TConfig,
  handler: SafeHandlerFn<SessionHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, SessionHandlerContext<TConfig>, TResult> =>
  createSafeDirectHandler(config, handler);

export type TokenHandlerConfig = InputSchema;

type TokenHandlerContext<
  TConfig extends TokenHandlerConfig = TokenHandlerConfig,
> = Context<UnwrapRoute<TConfig>>;

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
  TResult,
>(
  config: TConfig,
  handler: SafeHandlerFn<TokenHandlerContext<TConfig>, TResult>,
): SafeHandlerDefinition<TConfig, TokenHandlerContext<TConfig>, TResult> =>
  createSafeDirectHandler(config, handler);

type LogAndCaptureSafeErrorProps = {
  request: Request;
  route: string;
  error: unknown;
  statusCode: number;
};

const getErrorStatusCode = (error: Error): number | undefined => {
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if ("status" in error && typeof error.status === "number") {
    return error.status;
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
    // Walk up to three levels of `.cause` so nested wrappers
    // (generator-result re-throws, AI SDK over fetch errors,
    // etc.) don't hide the underlying failure type.
    const seen = new WeakSet<object>([error]);
    let cause: unknown = (error as { cause?: unknown }).cause;
    let depth = 1;
    while (cause instanceof Error && depth <= 3 && !seen.has(cause)) {
      seen.add(cause);
      const prefix = depth === 1 ? "error.cause" : `error.cause${depth}`;
      attributes[`${prefix}.type`] = errorTag(cause);
      cause = (cause as { cause?: unknown }).cause;
      depth++;
    }
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
