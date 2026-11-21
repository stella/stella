import { createFileRoute, redirect } from "@tanstack/react-router";

import { BILLING_MATTER_READ_PERMISSION } from "@stll/permissions";
import { Temporal } from "@stll/time";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { ensureMemberPermission } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { prefetchRouteQuery } from "@/lib/react-query";
import {
  expensesOptions,
  getExpensesWeekRange,
} from "@/lib/workspaces/queries/expenses";

import { ExpensesPage } from "./-expenses.page";
import { ExpensesPending } from "./-expenses.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/expenses",
)({
  beforeLoad: async ({ context, params }) => {
    if (
      !(await ensureMemberPermission({
        queryClient: context.queryClient,
        permissions: BILLING_MATTER_READ_PERMISSION,
      })) ||
      !(await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  loader: ({ context, params }) => {
    // Prefetch the current week's expenses using the exact same range
    // derivation (`getExpensesWeekRange`) the page component uses on mount,
    // so both compute an identical `expensesOptions` cache key and the fetch
    // starts during navigation instead of after the component mounts and
    // suspends.
    const { dateFrom, dateTo } = getExpensesWeekRange(
      Temporal.Now.instant()
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate(),
      getFormattingLocale(),
    );
    detached(
      prefetchRouteQuery(
        context.queryClient,
        expensesOptions(params.workspaceId, { dateFrom, dateTo }),
        (error: unknown) => {
          getAnalytics().captureError(error, {
            fingerprintKey: "workspaces.workspaceId.expenses.loader:failure",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate: "/_protected/workspaces/$workspaceId/expenses",
            },
          });
        },
      ),
      "expenses.prefetch",
    );
  },
  component: ExpensesPage,
  pendingComponent: ExpensesPending,
});
