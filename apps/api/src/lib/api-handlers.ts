import type { Err, UnhandledException } from "better-result";
import { Result } from "better-result";
import type {
  Context,
  ElysiaCustomStatusResponse,
  InputSchema,
  UnwrapRoute,
} from "elysia";
import { status } from "elysia";

import type { PermissionInput } from "@stella/permissions";
import { roles } from "@stella/permissions";

import type { SafeDb, ScopedDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { getRequestContext } from "@/api/lib/observability/request-context";

export type HandlerConfig = InputSchema & {
  permissions: PermissionInput;
};

type ConfigRouteSchema<TConfig extends HandlerConfig> = UnwrapRoute<
  Omit<TConfig, "permissions">
>;

type BaseHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  Context<ConfigRouteSchema<TConfig>> & {
    user: {
      id: SafeId<"user">;
    };
    session: {
      activeOrganizationId: SafeId<"organization">;
      token: string;
    };
    scopedDb: ScopedDb;
    safeDb: SafeDb;
    accessibleWorkspaces: AccessibleWorkspace[];
    memberRole: {
      role: keyof typeof roles;
    };
    orgAIConfig: OrgAIConfig | null;
  };

type RootHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig>;

type WorkspaceHandlerContext<TConfig extends HandlerConfig = HandlerConfig> =
  BaseHandlerContext<TConfig> & {
    workspaceId: SafeId<"workspace">;
  };

type Handler<TContext, TResult = unknown> = (
  ctx: TContext,
) => TResult | Promise<TResult>;

type HandlerDefinition<
  TConfig extends HandlerConfig = HandlerConfig,
  TContext = RootHandlerContext<TConfig>,
  TResult = unknown,
> = {
  config: TConfig;
  handler: (
    ctx: TContext,
  ) => Promise<TResult | ElysiaCustomStatusResponse<403>>;
};

const createScopedHandler = <
  TConfig extends HandlerConfig,
  TContext extends BaseHandlerContext<TConfig>,
  TResult,
>(
  config: TConfig,
  handler: Handler<TContext, TResult>,
): HandlerDefinition<TConfig, TContext, TResult> => ({
  config,
  handler: async (ctx: TContext) => {
    const hasPermission = roles[ctx.memberRole.role].authorize(
      config.permissions,
    );

    if (!hasPermission.success) {
      return status(403);
    }

    return await handler(ctx);
  },
});

export const createRootHandler = <
  TConfig extends HandlerConfig,
  TResult = unknown,
>(
  config: TConfig,
  handler: Handler<RootHandlerContext<TConfig>, TResult>,
): HandlerDefinition<TConfig, RootHandlerContext<TConfig>, TResult> =>
  createScopedHandler(config, handler);

export const createHandler = <TConfig extends HandlerConfig, TResult = unknown>(
  config: TConfig,
  handler: Handler<WorkspaceHandlerContext<TConfig>, TResult>,
): HandlerDefinition<TConfig, WorkspaceHandlerContext<TConfig>, TResult> =>
  createScopedHandler(config, handler);

type SafeHandlerError =
  | DatabaseError
  | DatabaseRlsError
  | HandlerError
  | UnhandledException;

type ExtractedHandlerError<TError extends SafeHandlerError> = Extract<
  TError,
  HandlerError
>;

type HandlerErrorStatus<TError extends SafeHandlerError> =
  ExtractedHandlerError<TError>["status"];

type SafeStatusCode<TError extends SafeHandlerError> =
  | 400
  | 403
  | 500
  | HandlerErrorStatus<TError>;

// The conditional form is intentional: it keeps status unions distributive so
// Eden sees distinct error codes like 405 instead of a single widened response.
type SafeStatusResponse<TStatusCode extends HandlerErrorStatusCode> =
  TStatusCode extends HandlerErrorStatusCode
    ? ElysiaCustomStatusResponse<TStatusCode>
    : never;

type SafeHandlerResult<TResult, TStatusCode extends HandlerErrorStatusCode> =
  | TResult
  | SafeStatusResponse<TStatusCode>;

type SafeRootHandler<
  TContext,
  TResult,
  TError extends SafeHandlerError = SafeHandlerError,
> = (
  ctx: TContext,
) => AsyncGenerator<
  Err<never, SafeHandlerError>,
  Result<TResult, TError>,
  unknown
>;

type SafeHandlerDefinition<
  TConfig extends HandlerConfig = HandlerConfig,
  TContext = RootHandlerContext<TConfig>,
  TResult = unknown,
  TError extends SafeHandlerError = SafeHandlerError,
> = {
  config: TConfig;
  handler: (
    ctx: TContext,
  ) => Promise<SafeHandlerResult<TResult, SafeStatusCode<TError>>>;
};

// This needs function overloads. A generic arrow returning `status(statusCode)`
// widens too much, and the casted version trips oxlint's unsafe assertion rule.
function toSafeStatusResponse<TStatusCode extends HandlerErrorStatusCode>(
  statusCode: TStatusCode,
): SafeStatusResponse<TStatusCode>;
function toSafeStatusResponse(statusCode: HandlerErrorStatusCode) {
  return status(statusCode);
}

export const createSafeRootHandler = <
  TConfig extends HandlerConfig,
  TResult,
  TError extends SafeHandlerError = SafeHandlerError,
>(
  config: TConfig,
  handler: SafeRootHandler<RootHandlerContext<TConfig>, TResult, TError>,
): SafeHandlerDefinition<
  TConfig,
  RootHandlerContext<TConfig>,
  TResult,
  TError
> => ({
  config,
  handler: async (
    ctx,
  ): Promise<SafeHandlerResult<TResult, SafeStatusCode<TError>>> => {
    const hasPermission = roles[ctx.memberRole.role].authorize(
      config.permissions,
    );

    if (!hasPermission.success) {
      return toSafeStatusResponse(403);
    }

    try {
      const result = await Result.gen(() => handler(ctx));

      if (Result.isOk(result)) {
        return result.value;
      }

      const error = result.error;

      if (HandlerError.is(error)) {
        const statusCode = error.status;

        if (statusCode >= 500) {
          logAndCaptureSafeRootError({
            request: ctx.request,
            route: ctx.route,
            error,
            statusCode,
          });
        }

        return toSafeStatusResponse<HandlerErrorStatus<TError>>(error.status);
      }

      if (DatabaseError.is(error)) {
        logAndCaptureSafeRootError({
          request: ctx.request,
          route: ctx.route,
          error,
          statusCode: 500,
        });

        return toSafeStatusResponse(500);
      }

      if (DatabaseRlsError.is(error)) {
        logAndCaptureSafeRootError({
          request: ctx.request,
          route: ctx.route,
          error,
          statusCode: 400,
        });

        return toSafeStatusResponse(400);
      }

      logAndCaptureSafeRootError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 500,
      });

      return toSafeStatusResponse(500);
    } catch (error) {
      logAndCaptureSafeRootError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 500,
      });

      return toSafeStatusResponse(500);
    }
  },
});

type LogAndCaptureSafeRootErrorProps = {
  request: Request;
  route: string;
  error: unknown;
  statusCode: number;
};

const logAndCaptureSafeRootError = ({
  request,
  route,
  error,
  statusCode,
}: LogAndCaptureSafeRootErrorProps) => {
  const path = new URL(request.url).pathname;
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

  if (reqCtx?.posthogDistinctId) {
    attributes.posthogDistinctId = reqCtx.posthogDistinctId;
  }

  if (reqCtx?.sessionId) {
    attributes.sessionId = reqCtx.sessionId;
  }

  if (reqCtx?.organizationId) {
    attributes["enduser.organization_id"] = reqCtx.organizationId;
  }

  logger.error("request.failed", attributes);

  captureError(error, {
    method: request.method,
    path,
  });
};
