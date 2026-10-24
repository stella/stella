import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { intersectAccessibleWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { ChatRegistryContextDeps } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { isMemberRole } from "@/api/lib/member-roles";
import { withCurrentMemberRole } from "@/api/lib/permission-authorization";

export type ResolveCurrentChatExecutionContext = (lookup: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => Promise<{
  accessibleWorkspaces: readonly AccessibleWorkspace[];
  featureAccessSnapshot: FeatureAccessSnapshot;
  pinServerValidatedWorkspaceId: (workspaceId: SafeId<"workspace">) => boolean;
  role: string;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userEmail: string;
} | null>;

/**
 * Replace turn-start authority with a live, operation-local context.
 *
 * The turn's matter set remains an attenuation boundary: newly gained access
 * cannot widen an already-running turn. Removed and deleting matters fall out,
 * while current statuses and database handles come from the new resolution.
 */
export const resolveCurrentChatRegistryContext = async ({
  contextDeps,
  resolveCurrentExecutionContext,
}: {
  contextDeps: ChatRegistryContextDeps;
  resolveCurrentExecutionContext: ResolveCurrentChatExecutionContext;
}): Promise<Result<ChatRegistryContextDeps, ChatToolError>> => {
  const resolved = await Result.tryPromise(
    async () =>
      await resolveCurrentExecutionContext({
        organizationId: contextDeps.organizationId,
        userId: contextDeps.userId,
      }),
  );
  if (Result.isError(resolved)) {
    return Result.err(
      new ChatToolError({
        kind: "transient",
        message: "Your current access could not be confirmed. Try again.",
        cause: resolved.error,
      }),
    );
  }

  const current = resolved.value;
  if (current === null || !isMemberRole(current.role)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "You are no longer a member of this organization.",
      }),
    );
  }

  const usableWorkspaces = current.accessibleWorkspaces.filter(
    ({ status }) => status !== "deleting",
  );
  const toolWorkspaceIds = intersectAccessibleWorkspaceIds({
    pinnedIds: contextDeps.toolWorkspaceIds,
    accessibleWorkspaceIds: usableWorkspaces.map(({ id }) => id),
  });

  return Result.ok({
    ...contextDeps,
    featureAccessSnapshot: current.featureAccessSnapshot,
    memberRole: withCurrentMemberRole(contextDeps.memberRole, current.role),
    pinServerValidatedWorkspaceId: current.pinServerValidatedWorkspaceId,
    safeDb: current.safeDb,
    scopedDb: current.scopedDb,
    toolWorkspaceIds,
    userEmail: current.userEmail,
    workspaceStatusById: new Map(
      usableWorkspaces.map(({ id, status }) => [id, status]),
    ),
  });
};
