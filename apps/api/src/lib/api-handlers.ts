import type { PermissionInput } from "@stll/permissions";
import { roles } from "@stll/permissions";
import type { Err, UnhandledException } from "better-result";
import { Result } from "better-result";
import type {
  Context,
  ElysiaCustomStatusResponse,
  InputSchema,
  UnwrapRoute,
} from "elysia";
import { status } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureRequestError } from "@/api/lib/analytics";
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

type SafeErrorBody = { message: string };

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
  TConfig extends HandlerConfig = HandlerConfig,
  TContext = RootHandlerContext<TConfig>,
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

        return toSafeStatusResponse(error.status, {
          message: error.message,
        });
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
        return toSafeStatusResponse(error.status, { message: error.message });
      }

      logAndCaptureSafeError({
        request: ctx.request,
        route: ctx.route,
        error,
        statusCode: 500,
      });

      return toSafeStatusResponse(500, { message: "Internal server error" });
    }
  },
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

type LogAndCaptureSafeErrorProps = {
  request: Request;
  route: string;
  error: unknown;
  statusCode: number;
};

const LOGGED_STACK_FRAME_COUNT = 3;
const LOGGED_STACK_FRAME_MAX_LENGTH = 768;

const errorStackFrames = (stack: string): string | undefined => {
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, LOGGED_STACK_FRAME_COUNT);

  if (frames.length === 0) {
    return undefined;
  }

  return frames.join("\n").slice(0, LOGGED_STACK_FRAME_MAX_LENGTH);
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
    attributes["error.message"] = error.message.slice(0, 512);
    if (error.stack) {
      const frames = errorStackFrames(error.stack);
      if (frames) {
        attributes["error.frames"] = frames;
      }
    }
    // Walk up to three levels of `.cause` so nested wrappers
    // (generator-result re-throws, AI SDK over fetch errors,
    // etc.) don't hide the underlying failure type. Nested
    // messages are deliberately omitted because they can carry
    // privileged payload snippets from external libraries.
    const seen = new WeakSet<object>([error]);
    let cause: unknown = (error as { cause?: unknown }).cause;
    let depth = 1;
    while (cause instanceof Error && depth <= 3 && !seen.has(cause)) {
      seen.add(cause);
      const prefix = depth === 1 ? "error.cause" : `error.cause${depth}`;
      attributes[`${prefix}.type`] = errorTag(cause);
      if (cause.stack) {
        const frames = errorStackFrames(cause.stack);
        if (frames) {
          attributes[`${prefix}.frames`] = frames;
        }
      }
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
