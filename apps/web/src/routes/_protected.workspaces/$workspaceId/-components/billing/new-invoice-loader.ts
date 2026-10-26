import type { QueryClient } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

type PendingApprovalsLoad = {
  queryClient: QueryClient;
  userId: string;
  workspaceId: string;
};

/**
 * Warms the invoice composer's pending-approval counts for an approver. The
 * counts are a hint the page reads on its own: a failed list is reported and
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
  const captureError = (error: unknown) => {
    getAnalytics().captureError(error, {
      fingerprintKey: "prefetchPendingApprovals:failure",
      scope: { type: "handler", handlerId: "prefetchPendingApprovals:failure" },
    });
  };
  await Promise.all([
    prefetchRouteQuery(
      queryClient,
      timeEntriesOptions(workspaceId, userId, { status: "draft" }),
      captureError,
    ),
    prefetchRouteQuery(
      queryClient,
      expensesOptions(workspaceId, { status: "draft" }),
      captureError,
    ),
  ]);
};
