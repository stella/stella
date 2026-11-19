import { createFileRoute } from "@tanstack/react-router";

import { loadRouteResource } from "@/lib/errors/route-resource";
import { ensureRouteQueryData } from "@/lib/react-query";
import { reportExportRecoveryOptions } from "@/lib/workspaces/queries/report-exports";

import { ReportExportRecoveryPage } from "./-report-export.page";
import { ReportExportRecoveryPending } from "./-report-export.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/reports/$exportId",
)({
  component: ReportExportRecoveryPage,
  loader: async ({ context, params }) => {
    await loadRouteResource({
      ids: [params.workspaceId, params.exportId],
      load: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          reportExportRecoveryOptions({ ...params, userId: context.user.id }),
        ),
    });
  },
  pendingComponent: ReportExportRecoveryPending,
});
