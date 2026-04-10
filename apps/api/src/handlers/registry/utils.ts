import { UserError } from "rivetkit";
import * as v from "valibot";

import {
  authedActorParamsSchema,
  parseActorKey,
} from "@stella/rivet/actors/common";
import { parseWorkflowActorKey } from "@stella/rivet/actors/workflow-actor-config";
import { userErrors } from "@stella/rivet/errors";
import type { UserErrorCode } from "@stella/rivet/errors";

import type { ScopedDb } from "@/api/db";
import { loadOrgAIConfig } from "@/api/lib/ai-config-cache";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { identify } from "@/api/lib/analytics";
import {
  getSessionAndMemberRole,
  resolveAccessibleWorkspaces,
} from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandActorSessionIdentity,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";

export {
  broadcastEvent,
  resetActorState,
} from "@/api/handlers/registry/runtime-utils";

export const createUserError = (
  errorCode: UserErrorCode,
  config?: { cause?: unknown; metadata?: unknown },
) =>
  new UserError(userErrors[errorCode], {
    code: errorCode,
    cause: config?.cause,
    metadata: config?.metadata,
  });

export type GlobalActorConnState = {
  authToken: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  orgAIConfig: OrgAIConfig | null;
};

export type UserActorConnState = GlobalActorConnState & {
  userId: SafeId<"user">;
};

type ActorConnState = GlobalActorConnState & {
  workspaceId: SafeId<"workspace">;
};

export const getScopedDb = (connState: GlobalActorConnState): ScopedDb =>
  createRootScopedDb({
    organizationId: connState.organizationId,
    userId: connState.userId,
    workspaceIds: connState.accessibleWorkspaceIds,
  });

const validateActorAuth = async (key: string[], params: unknown) => {
  const { authToken } = validateActorInput(authedActorParamsSchema, params);

  const { sessionResult, memberRoleResult } = await getSessionAndMemberRole({
    authorization: `Bearer ${authToken}`,
  });
  const session = sessionResult.unwrapOr(null);
  const memberRole = memberRoleResult.unwrapOr(null);

  if (!session || !memberRole) {
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

  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: rawOrgId,
    userId: session.user.id,
  });

  identify({
    distinctId: userId,
    properties: {
      active_organization_id: organizationId,
    },
  });

  // Load accessible workspaces and org AI config in
  // parallel to avoid sequential roundtrips.
  const [accessibleWorkspaces, orgAIConfig] = await Promise.all([
    resolveAccessibleWorkspaces(userId, organizationId, memberRole.role),
    loadOrgAIConfig(organizationId),
  ]);

  const accessibleWorkspaceIds = accessibleWorkspaces.map((w) => w.id);

  return {
    authToken,
    organizationId,
    sessionUserId: userId,
    parsedKey,
    accessibleWorkspaces,
    accessibleWorkspaceIds,
    orgAIConfig,
  };
};

export const validateGlobalActorSession = async (
  key: string[],
  params: unknown,
): Promise<GlobalActorConnState> => {
  const {
    authToken,
    organizationId,
    sessionUserId,
    accessibleWorkspaceIds,
    orgAIConfig,
  } = await validateActorAuth(key, params);

  return {
    authToken,
    organizationId,
    userId: sessionUserId,
    accessibleWorkspaceIds,
    orgAIConfig,
  };
};

export const validateUserActorSession = async (
  key: string[],
  params: unknown,
): Promise<UserActorConnState> => {
  const {
    authToken,
    organizationId,
    sessionUserId,
    parsedKey,
    accessibleWorkspaceIds,
    orgAIConfig,
  } = await validateActorAuth(key, params);

  if (!parsedKey.userId) {
    throw createUserError("invalid-params");
  }

  if (parsedKey.userId !== sessionUserId) {
    throw createUserError("forbidden");
  }

  return {
    authToken,
    organizationId,
    userId: sessionUserId,
    accessibleWorkspaceIds,
    orgAIConfig,
  };
};

export const validateActorSession = async (
  key: string[],
  params: unknown,
): Promise<ActorConnState> => {
  const {
    authToken,
    organizationId,
    sessionUserId,
    parsedKey,
    accessibleWorkspaces,
    accessibleWorkspaceIds,
    orgAIConfig,
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
    userId: sessionUserId,
    workspaceId: ws.id,
    accessibleWorkspaceIds,
    orgAIConfig,
  };
};

export const validateActorInput = <T>(
  schema: v.GenericSchema<T>,
  input: unknown,
) => {
  const result = v.safeParser(schema)(input);

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
  return brandValidatedWorkflowActorKey(parsed);
};
