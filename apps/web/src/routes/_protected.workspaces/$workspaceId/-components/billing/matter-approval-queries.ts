import { BILLING_STATUS } from "@stll/api-contract";

import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

export const submittedMatterTimeOptions = (
  workspaceId: string,
  userId: string,
) =>
  timeEntriesOptions(workspaceId, userId, {
    status: BILLING_STATUS.SUBMITTED,
  });

export const approvedMatterTimeOptions = (
  workspaceId: string,
  userId: string,
) =>
  timeEntriesOptions(workspaceId, userId, {
    status: BILLING_STATUS.APPROVED,
  });

export const draftMatterExpensesOptions = (workspaceId: string) =>
  expensesOptions(workspaceId, { status: BILLING_STATUS.DRAFT });

export const approvedMatterExpensesOptions = (workspaceId: string) =>
  expensesOptions(workspaceId, {
    status: BILLING_STATUS.APPROVED,
  });
