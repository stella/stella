import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { routeLoadMode } from "@/lib/query-view.logic";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import {
  timeEntriesInfiniteOptions,
  timeEntrySuggestionsOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { routeSearchSchema } from "@/route-search-params";

import {
  approvedMatterExpensesOptions,
  approvedMatterTimeOptions,
  draftMatterExpensesOptions,
  submittedMatterTimeOptions,
} from "./-components/billing/matter-approval-queries";
import { TimesheetsPage } from "./-timesheets.page";
import { MatterTimesheetsPending } from "./-timesheets.pending";

/**
 * `view=approvals` opens the matter's approval queue, so the invoice composer
 * can link straight to the work that is waiting.
 */
const timesheetsSearchSchema = routeSearchSchema({
  view: v.optional(v.picklist(["approvals"])),
  rates: v.optional(v.literal("manage")),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  validateSearch: timesheetsSearchSchema,
  loaderDeps: ({ search }) => ({ view: search.view }),
  beforeLoad: async ({ context, params }) => {
    if (
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

    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    const canReadTimeEntries = authClient.organization.checkRolePermission({
      role,
      permissions: { timeEntry: ["read"] },
    });
    if (!canReadTimeEntries) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }

    return {
      canApproveMatterTime: authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["approve"] },
      }),
    };
  },
  loader: async ({ cause, context, deps, params }) => {
    const { queryClient, user } = context;
    const { workspaceId } = params;
    const opensApprovals =
      deps.view === "approvals" && context.canApproveMatterTime;
    const today = Temporal.Now.instant()
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate()
      .toString();
    const entries = timeEntriesInfiniteOptions(workspaceId, user.id, {
      dateFrom: today,
      dateTo: today,
      scope: "me",
    });
    const submitted = submittedMatterTimeOptions(workspaceId, user.id);
    const approved = approvedMatterTimeOptions(workspaceId, user.id);
    const draftExpenses = draftMatterExpensesOptions(workspaceId);
    const approvedExpenses = approvedMatterExpensesOptions(workspaceId);
    const summary = timeEntrySummaryOptions(workspaceId, user.id, today, today);
    const suggestions = timeEntrySuggestionsOptions(
      workspaceId,
      user.id,
      today,
      Temporal.Now.timeZoneId(),
    );
    const queries = opensApprovals
      ? [submitted, approved, draftExpenses, approvedExpenses]
      : [entries, summary, suggestions];
    let hasCachedPages = true;
    for (const options of queries) {
      if (queryClient.getQueryData(options.queryKey) === undefined) {
        hasCachedPages = false;
        break;
      }
    }
    const mode = routeLoadMode({ cause, hasCachedPages });
    if (hasCachedPages && mode === "background") {
      return;
    }
    const loading = opensApprovals
      ? Promise.all([
          ensureRouteQueryData(queryClient, submitted),
          ensureRouteQueryData(queryClient, approved),
          ensureRouteQueryData(queryClient, draftExpenses),
          ensureRouteQueryData(queryClient, approvedExpenses),
        ])
      : Promise.all([
          ensureRouteInfiniteQueryData(queryClient, entries),
          ensureRouteQueryData(queryClient, summary),
          ensureRouteQueryData(queryClient, suggestions),
        ]);
    if (mode === "await") {
      await loading;
    } else {
      detached(loading, "timesheets.view-prefetch");
    }
  },
  remountDeps: ({ params }) => params.workspaceId,
  pendingComponent: MatterTimesheetsPending,
  component: TimesheetsPage,
});
