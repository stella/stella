import { UserError, type ActionContextOf, type ActorContext } from "rivetkit";
import * as v from "valibot";

import {
  authedActorParamsSchema,
  parseActorKey,
} from "@stella/rivet/actors/common";
import { userErrors, type UserErrorCode } from "@stella/rivet/errors";
import type { ActorEvent } from "@stella/rivet/types";

import { db } from "@/api/db";
import type { ActorsUnion } from "@/api/handlers/registry";
import { auth } from "@/api/lib/auth";
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

  const activeOrganizationId = session.session.activeOrganizationId;
  const parsedKey = parseActorKey<{
    organizationId: string;
    workspaceId: string | undefined;
    userId: string | undefined;
  }>(key);

  if (parsedKey.organizationId !== activeOrganizationId) {
    throw createUserError("forbidden");
  }

  posthogIdentify({
    distinctId: session.user.id,
    properties: {
      active_organization_id: activeOrganizationId,
    },
  });

  return {
    authToken,
    activeOrganizationId,
    sessionUserId: session.user.id,
    parsedKey,
  };
};

export const validateGlobalActorSession = async (
  key: string[],
  params: unknown,
): Promise<GlobalActorConnState> => {
  const { authToken, activeOrganizationId } = await validateActorAuth(
    key,
    params,
  );

  return {
    authToken,
    organizationId: toSafeId<"organization">(activeOrganizationId),
  };
};

export const validateUserActorSession = async (
  key: string[],
  params: unknown,
): Promise<UserActorConnState> => {
  const { authToken, activeOrganizationId, sessionUserId, parsedKey } =
    await validateActorAuth(key, params);

  if (!parsedKey.userId) {
    throw createUserError("invalid-arguments");
  }

  if (parsedKey.userId !== sessionUserId) {
    throw createUserError("forbidden");
  }

  return {
    authToken,
    organizationId: toSafeId<"organization">(activeOrganizationId),
    userId: parsedKey.userId,
  };
};

export const validateActorSession = async (
  key: string[],
  params: unknown,
): Promise<ActorConnState> => {
  const { authToken, activeOrganizationId, parsedKey } =
    await validateActorAuth(key, params);

  if (!parsedKey.workspaceId) {
    throw createUserError("invalid-arguments");
  }

  const { workspaceId } = parsedKey;

  const workspace = await db.query.workspaces.findFirst({
    columns: {
      status: true,
      organizationId: true,
    },
    where: {
      id: workspaceId,
    },
  });

  if (!workspace || workspace.status !== "active") {
    throw createUserError("invalid-arguments");
  }

  if (workspace.organizationId !== activeOrganizationId) {
    throw createUserError("forbidden");
  }

  return {
    authToken,
    organizationId: toSafeId<"organization">(activeOrganizationId),
    workspaceId: toSafeId<"workspace">(workspaceId),
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
