import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import type { PendingUploadPurposeData } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

export const uploadRoutePermission = {
  workspace: ["read"],
} satisfies PermissionInput;

export type UploadPurpose = PendingUploadPurposeData["type"];

/**
 * The permission each purpose actually spends. Total over the purpose union, so
 * a new purpose cannot be added without deciding what it costs: a fallback
 * branch would silently hand the new purpose whatever the last one required.
 */
export const UPLOAD_PURPOSE_PERMISSION = {
  entity_create: { entity: ["create"] },
  entity_version: { entity: ["update"] },
  agent_skill: { agentSkill: ["create"] },
} as const satisfies Record<UploadPurpose, PermissionInput>;

type AuthorizeUploadPurposeProps = {
  memberRole: AuthorizedMemberRole;
  purpose: UploadPurpose;
};

export const authorizeUploadPurpose = ({
  memberRole,
  purpose,
}: AuthorizeUploadPurposeProps): Result<void, HandlerError> => {
  if (hasMemberPermission(memberRole, UPLOAD_PURPOSE_PERMISSION[purpose])) {
    return Result.ok(undefined);
  }
  return Result.err(new HandlerError({ status: 403, message: "Forbidden" }));
};
