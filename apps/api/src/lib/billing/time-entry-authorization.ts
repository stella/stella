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

/**
 * Approving changes another timekeeper's entry, so the assigned approver path
 * spends `timeEntry:update` even though the approval queue itself is open to
 * readers. Every role that can read time entries holds it; a credential
 * narrowed below it approves nothing, assigned or not.
 */
export const canApproveAssignedTimeEntry = ({
  memberRole,
  currentUserId,
  approverUserId,
}: {
  memberRole: AuthorizedMemberRole;
  currentUserId: SafeId<"user">;
  approverUserId: string | null;
}) =>
  canApproveTimeEntries(memberRole) ||
  (approverUserId === currentUserId &&
    hasMemberPermission(memberRole, { timeEntry: ["update"] }));
