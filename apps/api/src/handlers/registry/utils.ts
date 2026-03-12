import { UserError } from "rivetkit";
import type { ActionContextOf, ActorContext } from "rivetkit";
import * as v from "valibot";

import {
  authedActorParamsSchema,
  parseActorKey,
} from "@stella/rivet/actors/common";
import { parseWorkflowActorKey } from "@stella/rivet/actors/workflow-actor-config";
import { userErrors } from "@stella/rivet/errors";
import type { UserErrorCode } from "@stella/rivet/errors";
import type { ActorEvent } from "@stella/rivet/types";

import { createScopedDb, db } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import type { ActorsUnion } from "@/api/handlers/registry";
import { auth, resolveAccessibleWorkspaces } from "@/api/lib/auth";
// oxlint-disable-next-line no-restricted-imports: actor session validator (equivalent to authMacro)
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { posthogIdentify } from "@/api/lib/posthog";

export const createUserError = (
  errorCode: UserErrorCode,
  config?: { cause?: unknown; metadata?: unknown },
) =>
  new UserError(userErrors[errorCode], {
    code: errorCode,
    cause: config?.cause,
    metadata: config?.metadata,
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// oxlint-disable-next-line typescript-eslint/no-explicit-any -- any is intentional here
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
  const userId = toSafeId<"user">(session.user.id);

  posthogIdentify({
    distinctId: userId,
    properties: {
      active_organization_id: organizationId,
    },
  });

  // Centralised workspace resolution: same logic as authMacro,
  // so actors and HTTP handlers share one code path.
  const accessibleWorkspaces = await resolveAccessibleWorkspaces(
    userId,
    organizationId,
  );
  const scopedDb = createScopedDb(
    db,
    accessibleWorkspaces.map((w) => w.id),
    organizationId,
  );

  return {
    authToken,
    organizationId,
    sessionUserId: session.user.id,
    parsedKey,
    accessibleWorkspaces,
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
    accessibleWorkspaces,
    scopedDb,
  } = await validateActorAuth(key, params);

  if (!parsedKey.workspaceId) {
    throw createUserError("invalid-params");
  }

  const { workspaceId } = parsedKey;

  const ws = accessibleWorkspaces.find((w) => w.id === workspaceId);

  if (!ws || ws.status !== "active") {
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
