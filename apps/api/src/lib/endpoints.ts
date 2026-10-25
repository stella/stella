/**
 * Endpoints that are part of the API's plumbing rather than a capability: the
 * health probes, discovery documents, auth redirects, event streams, signed
 * webhooks. They carry no permission, usage or catalog policy, so they skip
 * the safe-handler factories, but they decode their input and decide their
 * caller exactly like every other route. Business operations use the
 * factories in `lib/api-handlers.ts`.
 */
import type { CachePolicy } from "@/api/http/cache";
import { decodeRequestInput } from "@/api/http/input";
import type {
  RouteConfig,
  RouteDefinition,
  RouteRequest,
} from "@/api/http/route";
import { decodeRouteInput, routeContext } from "@/api/http/route-input";
import type { RouteContext } from "@/api/http/route-input";
import {
  authenticateMember,
  authenticateSession,
  authorizeWorkspace,
} from "@/api/lib/auth";
import type {
  CallerOutcome,
  SessionCaller,
  ValidateAuthValue,
  WorkspaceCaller,
} from "@/api/lib/auth";
import type { HandoffAccessMetadata } from "@/api/lib/auth/handoff-step-up-policy";
import { workspaceSegmentSchema } from "@/api/lib/custom-schema";

type EndpointConfig = RouteConfig & {
  /** How long a successful answer may be cached; absent means not at all. */
  readonly cache?: CachePolicy;
  /** `own`: the endpoint answers CORS itself (an any-origin discovery document). */
  readonly cors?: "own";
};

type Handler<TContext, TAnswer> = (ctx: TContext) => TAnswer | Promise<TAnswer>;

/** The answer refusing a caller before the endpoint's handler runs. */
type AccessRefusal = Extract<CallerOutcome<never>, { ok: false }>["answer"];

/**
 * An endpoint as a route: its own config and its handler's answer stay in
 * the type, so the web contract types the endpoint like any other route.
 */
type EndpointDefinition<TConfig extends EndpointConfig, TAnswer> = Omit<
  RouteDefinition,
  "config" | "run"
> & {
  readonly config: TConfig;
  readonly run: (request: RouteRequest) => Promise<TAnswer>;
};

type NoInput = Record<never, never>;

/** What a member endpoint's handler sees. */
type MemberEndpointContext<TConfig extends EndpointConfig = NoInput> =
  RouteContext<TConfig> & ValidateAuthValue;

/** What a workspace endpoint's handler sees: the member and the proven matter. */
export type WorkspaceEndpointContext<TConfig extends EndpointConfig = NoInput> =
  MemberEndpointContext<TConfig> & WorkspaceCaller;

/**
 * Plumbing declares no account access or permissions, so only a sensitive
 * path (an export, a download) asks a session opened from an MCP web link to
 * sign in again.
 */
const PLUMBING_ACCESS: HandoffAccessMetadata = {};

const policyOf = (config: EndpointConfig) => ({
  ...(config.cache === undefined ? {} : { cache: config.cache }),
  ...(config.cors === undefined ? {} : { cors: config.cors }),
});

/** Anyone may call it. */
const publicEndpoint = <TConfig extends EndpointConfig, TAnswer>(
  config: TConfig,
  handler: Handler<RouteContext<TConfig>, TAnswer>,
): EndpointDefinition<TConfig, TAnswer> => ({
  config,
  access: "public",
  ...policyOf(config),
  run: async (request) =>
    await handler(
      routeContext(
        request,
        await decodeRouteInput(config, request, await request.readBody()),
      ),
    ),
});

/** A signed-in account with a live stored session. */
const sessionEndpoint = <TConfig extends EndpointConfig, TAnswer>(
  config: TConfig,
  handler: Handler<RouteContext<TConfig> & SessionCaller, TAnswer>,
): EndpointDefinition<TConfig, TAnswer | AccessRefusal> => ({
  config,
  access: "session",
  ...policyOf(config),
  run: async (request) => {
    const account = await authenticateSession(request.ctx, PLUMBING_ACCESS);
    if (!account.ok) {
      return account.answer;
    }
    const input = await decodeRouteInput(
      config,
      request,
      await request.readBody(),
    );
    return await handler({
      ...routeContext(request, input),
      ...account.caller,
    });
  },
});

/** A signed-in member of the active organization. */
const memberEndpoint = <TConfig extends EndpointConfig, TAnswer>(
  config: TConfig,
  handler: Handler<MemberEndpointContext<TConfig>, TAnswer>,
): EndpointDefinition<TConfig, TAnswer | AccessRefusal> => ({
  config,
  access: "member",
  ...policyOf(config),
  run: async (request) => {
    const member = await authenticateMember(request.ctx, PLUMBING_ACCESS);
    if (!member.ok) {
      return member.answer;
    }
    const input = await decodeRouteInput(
      config,
      request,
      await request.readBody(),
    );
    return await handler({ ...routeContext(request, input), ...member.caller });
  },
});

/** A member with access to the active matter the `:workspaceId` segment names. */
const workspaceEndpoint = <TConfig extends EndpointConfig, TAnswer>(
  config: TConfig,
  handler: Handler<WorkspaceEndpointContext<TConfig>, TAnswer>,
): EndpointDefinition<TConfig, TAnswer | AccessRefusal> => ({
  config,
  access: "workspace",
  ...policyOf(config),
  run: async (request) => {
    const member = await authenticateMember(request.ctx, PLUMBING_ACCESS);
    if (!member.ok) {
      return member.answer;
    }
    const { workspaceId } = await decodeRequestInput(
      workspaceSegmentSchema,
      request.ctx.params,
    );
    const matter = await authorizeWorkspace(
      member.caller,
      request.ctx,
      workspaceId,
      "active",
    );
    if (!matter.ok) {
      return matter.answer;
    }
    const input = await decodeRouteInput(
      config,
      request,
      await request.readBody(),
    );
    return await handler({
      ...routeContext(request, input),
      ...member.caller,
      ...matter.caller,
    });
  },
});

export const defineEndpoint = {
  public: publicEndpoint,
  session: sessionEndpoint,
  member: memberEndpoint,
  workspace: workspaceEndpoint,
};
