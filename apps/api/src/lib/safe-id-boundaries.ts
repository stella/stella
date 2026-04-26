import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type ActorSessionIdentityInput = {
  organizationId: string;
  userId: string;
};

type WorkflowActorKeyInput = {
  organizationId: string;
  workspaceId: string;
};

export const brandActorSessionIdentity = ({
  organizationId,
  userId,
}: ActorSessionIdentityInput): {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
} => ({
  organizationId: toSafeId<"organization">(organizationId),
  userId: toSafeId<"user">(userId),
});

export const brandPersistedWorkspaceId = (
  workspaceId: string,
): SafeId<"workspace"> => toSafeId<"workspace">(workspaceId);

export const brandPersistedUserId = (userId: string): SafeId<"user"> =>
  toSafeId<"user">(userId);

export const brandPersistedOrganizationId = (
  organizationId: string,
): SafeId<"organization"> => toSafeId<"organization">(organizationId);

export const brandValidatedWorkflowActorKey = ({
  organizationId,
  workspaceId,
}: WorkflowActorKeyInput): {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
} => ({
  organizationId: toSafeId<"organization">(organizationId),
  workspaceId: toSafeId<"workspace">(workspaceId),
});
