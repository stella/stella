import { status } from "elysia";
import type {
  Context,
  ElysiaCustomStatusResponse,
  InputSchema,
  UnwrapRoute,
} from "elysia";

import { roles } from "@stella/permissions";
import type { PermissionInput } from "@stella/permissions";

import type { ScopedDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";

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
