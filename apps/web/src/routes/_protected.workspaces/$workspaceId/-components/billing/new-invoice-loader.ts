import type { QueryClient } from "@tanstack/react-query";

import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

type PendingApprovalsLoad = {
  queryClient: QueryClient;
  userId: string;
  workspaceId: string;
};

/**
 * Warms the invoice composer's pending-approval counts for an approver. The
 * counts are a hint the page reads on its own: a failed list settles here and
 * never rejects, so the composer still opens.
 */
export const prefetchPendingApprovals = async ({
  queryClient,
  userId,
  workspaceId,
}: PendingApprovalsLoad) => {
  const role = await ensureRouteQueryData(queryClient, roleOptions);
  if (
    !authClient.organization.checkRolePermission({
      role,
      permissions: { timeEntry: ["approve"] },
    })
  ) {
    return;
  }
  await Promise.all([
    queryClient.prefetchQuery(
      timeEntriesOptions(workspaceId, userId, { status: "draft" }),
    ),
    queryClient.prefetchQuery(
      expensesOptions(workspaceId, { status: "draft" }),
    ),
  ]);
};
