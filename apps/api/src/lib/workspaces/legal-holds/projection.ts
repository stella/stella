import type { SafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  hasManagementPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

import { UNIDENTIFIED_LEGAL_HOLD_VIEWER } from "./errors";
import type { LegalHoldViewer } from "./errors";

/**
 * The member viewer of a hold. Organization owners and administrators whose
 * credential may place holds manage them, and so read every hold's reason.
 */
export const legalHoldViewer = ({
  userId,
  memberRole,
}: {
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
}): LegalHoldViewer => ({
  type: "member",
  userId,
  managesHolds: hasManagementPermission(memberRole, { legalHold: ["place"] }),
});

/** The viewer of a handler request, read from its authorized context. */
export const legalHoldViewerFromContext = (ctx: object): LegalHoldViewer => {
  const memberRole = readAuthorizedMemberRole(ctx);
  const user: unknown = Object.hasOwn(ctx, "user")
    ? Reflect.get(ctx, "user")
    : undefined;
  const userId: unknown = isRecord(user) ? user["id"] : undefined;
  if (memberRole === null || typeof userId !== "string") {
    return UNIDENTIFIED_LEGAL_HOLD_VIEWER;
  }
  return legalHoldViewer({ userId: brandPersistedUserId(userId), memberRole });
};
