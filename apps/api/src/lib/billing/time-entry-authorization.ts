import type { SafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

export const canApproveTimeEntries = (
  memberRole: AuthorizedMemberRole,
): boolean => hasMemberPermission(memberRole, { timeEntry: ["approve"] });

type CanManageTimeEntryOptions = {
  memberRole: AuthorizedMemberRole;
  currentUserId: SafeId<"user">;
  entryUserId: string | null;
};

export const canManageTimeEntry = ({
  memberRole,
  currentUserId,
  entryUserId,
}: CanManageTimeEntryOptions): boolean =>
  entryUserId === currentUserId || canApproveTimeEntries(memberRole);
