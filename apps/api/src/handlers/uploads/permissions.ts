import { Result } from "better-result";

import { roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import type { PendingUploadPurposeData } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const uploadRoutePermission = {
  workspace: ["read"],
} satisfies PermissionInput;

type UploadPurpose = PendingUploadPurposeData["type"];

const uploadPurposePermission = (purpose: UploadPurpose): PermissionInput => {
  if (purpose === "entity_create") {
    return { entity: ["create"] };
  }
  if (purpose === "entity_version") {
    return { entity: ["update"] };
  }
  return { agentSkill: ["create"] };
};

type AuthorizeUploadPurposeProps = {
  memberRole: { role: keyof typeof roles };
  purpose: UploadPurpose;
};

export const authorizeUploadPurpose = ({
  memberRole,
  purpose,
}: AuthorizeUploadPurposeProps): Result<void, HandlerError> => {
  const authorization = roles[memberRole.role].authorize(
    uploadPurposePermission(purpose),
  );
  if (authorization.success) {
    return Result.ok(undefined);
  }
  return Result.err(new HandlerError({ status: 403, message: "Forbidden" }));
};
