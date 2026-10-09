import {
  clearMemberAssignments as clearOwnedMemberAssignments,
  tryLockMemberCleanupWorkspace as tryLockOwnedMemberCleanupWorkspace,
  tryLockAccountMemberCleanup as tryLockOwnedAccountMemberCleanup,
  removeOrganizationMemberInTransaction as removeOwnedOrganizationMember,
} from "@/api/lib/member-assignment-offboarding-owner";

export const clearMemberAssignments = async (
  ...args: Parameters<typeof clearOwnedMemberAssignments>
): Promise<void> => {
  await clearOwnedMemberAssignments(...args);
};

export const tryLockMemberCleanupWorkspace = async (
  ...args: Parameters<typeof tryLockOwnedMemberCleanupWorkspace>
): Promise<void> => {
  await tryLockOwnedMemberCleanupWorkspace(...args);
};

export const tryLockAccountMemberCleanup = async (
  tx: Parameters<typeof tryLockOwnedAccountMemberCleanup>[0]["tx"],
  userId: Parameters<typeof tryLockOwnedAccountMemberCleanup>[0]["userId"],
): Promise<void> => {
  await tryLockOwnedAccountMemberCleanup({ tx, userId });
};

export const removeOrganizationMemberInTransaction = async (
  ...args: Parameters<typeof removeOwnedOrganizationMember>
): Promise<void> => {
  await removeOwnedOrganizationMember(...args);
};
