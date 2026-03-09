import { UserError, type ActionContextOf, type ActorContext } from "rivetkit";
import * as v from "valibot";

import {
  authedActorParamsSchema,
  parseActorKey,
} from "@stella/rivet/actors/common";
import { parseWorkflowActorKey } from "@stella/rivet/actors/workflow-actor-config";
import { userErrors, type UserErrorCode } from "@stella/rivet/errors";
import type { ActorEvent } from "@stella/rivet/types";

import { adminDb, createScopedDb, type ScopedDb } from "@/api/db";
import type { ActorsUnion } from "@/api/handlers/registry";
import {
  auth,
  resolveAccessibleWorkspaceIds,
  WORKSPACE_ACTIVE_STATUS,
} from "@/api/lib/auth";
// biome-ignore lint/style/noRestrictedImports: actor session validator (equivalent to authMacro)
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { posthogIdentify } from "@/api/lib/posthog";

export const createUserError = (
  errorCode: UserErrorCode,
  config?: { cause?: unknown; metadata?: unknown },
) => {
  return new UserError(userErrors[errorCode], {
    code: errorCode,
    cause: config?.cause,
    metadata: config?.metadata,
  });
};

// biome-ignore lint/suspicious/noExplicitAny: it's fine
type AnyActorContext = ActorContext<any, any, any, any, any, any>;

/** Context with a broadcast method. Accepts any actor context (including chat). */
type BroadcastCapableContext = Pick<AnyActorContext, "broadcast">;

export const broadcastEvent = (c: BroadcastCapableContext, event: ActorEvent) =>
  c.broadcast(event.name, event.data);

export type GlobalActorConnState = {
  authToken: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
};

export type UserActorConnState = GlobalActorConnState & {
  userId: string;
};

export type ActorConnState = GlobalActorConnState & {
  workspaceId: SafeId<"workspace">;
};

const validateActorAuth = async (key: string[], params: unknown) => {
  const { authToken } = validateActorInput(authedActorParamsSchema, params);

  const session = await auth.api.getSession({
    headers: {
      authorization: `Bearer ${authToken}`,
    },
  });

  if (!session) {
    throw createUserError("unauthorized");
  }

  const rawOrgId = session.session.activeOrganizationId;
  const parsedKey = parseActorKey<{
    organizationId: string;
    workspaceId: string | undefined;
    userId: string | undefined;
  }>(key);

  if (parsedKey.organizationId !== rawOrgId) {
    throw createUserError("forbidden");
  }

  const organizationId = toSafeId<"organization">(rawOrgId);

  posthogIdentify({
    distinctId: session.user.id,
    properties: {
      active_organization_id: organizationId,
    },
  });

  // Centralised workspace resolution: same logic as authMacro,
  // so actors and HTTP handlers share one code path.
  const accessibleWorkspaceIds = await resolveAccessibleWorkspaceIds(
    session.user.id,
    organizationId,
  );
  const scopedDb = createScopedDb(accessibleWorkspaceIds);

  return {
    authToken,
    organizationId,
    sessionUserId: session.user.id,
    parsedKey,
    accessibleWorkspaceIds,
    scopedDb,
  };
};

export const validateGlobalActorSession = async (
  key: string[],
  params: unknown,
): Promise<GlobalActorConnState> => {
  const { authToken, organizationId, scopedDb } = await validateActorAuth(
    key,
    params,
  );

  return { authToken, organizationId, scopedDb };
};

export const validateUserActorSession = async (
  key: string[],
  params: unknown,
): Promise<UserActorConnState> => {
  const { authToken, organizationId, sessionUserId, parsedKey, scopedDb } =
    await validateActorAuth(key, params);

  if (!parsedKey.userId) {
    throw createUserError("invalid-params");
  }

  if (parsedKey.userId !== sessionUserId) {
    throw createUserError("forbidden");
  }

  return {
    authToken,
    organizationId,
    userId: parsedKey.userId,
    scopedDb,
  };
};

export const validateActorSession = async (
  key: string[],
  params: unknown,
): Promise<ActorConnState> => {
  const {
    authToken,
    organizationId,
    parsedKey,
    accessibleWorkspaceIds,
    scopedDb,
  } = await validateActorAuth(key, params);

  if (!parsedKey.workspaceId) {
    throw createUserError("invalid-params");
  }

  const { workspaceId } = parsedKey;

  // Membership gate: RLS protects DB reads, but actor
  // side-effects (broadcasts, state mutations) are not
  // gated by RLS. Reject non-members early.
  if (!accessibleWorkspaceIds.includes(workspaceId)) {
    throw createUserError("forbidden");
  }

  // Defense in depth: validates workspace existence,
  // active status, and org ownership independently.
  const workspace = await adminDb.query.workspaces.findFirst({
    columns: {
      status: true,
      organizationId: true,
    },
    where: {
      id: workspaceId,
    },
  });

  if (!workspace || workspace.status !== WORKSPACE_ACTIVE_STATUS) {
    throw createUserError("invalid-arguments");
  }

  if (workspace.organizationId !== organizationId) {
    throw createUserError("forbidden");
  }

  return {
    authToken,
    organizationId,
    workspaceId: toSafeId<"workspace">(workspaceId),
    scopedDb,
  };
};

export const validateActorInput = <T>(
  schema: v.GenericSchema<T>,
  input: unknown,
) => {
  const result = v.safeParse(schema, input);

  if (!result.success) {
    throw createUserError("invalid-arguments", {
      cause: result.issues,
    });
  }

  return result.output;
};

/** Parse a workflow actor key and brand the IDs.
 *  The actor key was validated at connection time, so
 *  branding the parsed values is sound. */
export const parseBrandedWorkflowActorKey = (key: string | string[]) => {
  const parsed = parseWorkflowActorKey(key);
  return {
    organizationId: toSafeId<"organization">(parsed.organizationId),
    workspaceId: toSafeId<"workspace">(parsed.workspaceId),
  };
};

export const resetActorState = <TContext extends ActionContextOf<ActorsUnion>>(
  c: TContext,
  defaultState: TContext["state"],
) => {
  for (const key in defaultState) {
    if (Object.hasOwn(defaultState, key)) {
      // @ts-expect-error - this is valid
      c.state[key] = defaultState[key];
    }
  }
};
