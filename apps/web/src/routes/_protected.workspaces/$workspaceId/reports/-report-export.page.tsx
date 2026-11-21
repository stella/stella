import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { reportExportRecoveryOptions } from "@/lib/workspaces/queries/report-exports";
import { resolveReportExportDestinationQuery } from "@/lib/workspaces/resolve-report-export-destination-query";
import { DEFAULT_WORKSPACE_VIEW_ID } from "@/lib/workspaces/view-params.logic";

import { ReportExportRecoveryShell } from "./-report-export.pending";

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/reports/$exportId",
);

export function ReportExportRecoveryPage() {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { exportId, workspaceId } = routeApi.useParams({
    select: (params) => ({
      exportId: params.exportId,
      workspaceId: params.workspaceId,
    }),
  });
  const userId = routeApi.useRouteContext({
    select: (context) => context.user.id,
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const { data, refetch } = useSuspenseQuery(
    reportExportRecoveryOptions({ exportId, userId, workspaceId }),
  );
  let statusTitle = t("common.preparing");
  if (data.status === "completed") {
    statusTitle = t("workspaces.views.reportExport.completed");
  } else if (data.status === "failed") {
    statusTitle = t("workspaces.views.reportExport.failed");
  }

  const handleDownload = async () => {
    setIsDownloading(true);
    const result = await Result.tryPromise(
      async () => await refetch({ throwOnError: true }),
    );
    setIsDownloading(false);

    if (Result.isError(result)) {
      analytics.captureError(result.error, {
        fingerprintKey: "ReportExportRecoveryPage.handleDownload:failure",
        scope: {
          type: "handler",
          handlerId: "ReportExportRecoveryPage.handleDownload:failure",
        },
      });
      notifyUserError(result.error, t("common.unexpectedError"));
      return;
    }

    const downloadUrl = result.value.data?.downloadUrl;
    if (!downloadUrl) {
      notifyUserProblem(t("common.unexpectedError"));
      return;
    }

    triggerUrlDownload(downloadUrl);
  };

  const handleDownloadClick = () => {
    detached(
      handleDownload().catch((error: unknown) => {
        analytics.captureError(error, {
          fingerprintKey:
            "ReportExportRecoveryPage.handleDownloadClick:failure",
          scope: {
            type: "handler",
            handlerId: "ReportExportRecoveryPage.handleDownloadClick:failure",
          },
        });
        notifyUserError(error, t("common.unexpectedError"));
      }),
      "reports.download",
    );
  };

  const handleOpen = async () => {
    const result = await Result.tryPromise(async () => {
      const destination = await resolveReportExportDestinationQuery({
        exportId,
        queryClient,
        userId,
        workspaceId,
      });
      if (destination === null) {
        return null;
      }
      // The report page sits outside every view of the matter.
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId: DEFAULT_WORKSPACE_VIEW_ID },
        search: {
          entity: destination.entityId,
          field: destination.fieldId,
        },
      });
      return destination;
    });
    if (Result.isError(result) || result.value === null) {
      if (Result.isError(result)) {
        analytics.captureError(result.error, {
          fingerprintKey: "ReportExportRecoveryPage.handleOpen:failure",
          scope: {
            type: "handler",
            handlerId: "ReportExportRecoveryPage.handleOpen:failure",
          },
        });
      }
      notifyUserError(
        Result.isError(result) ? result.error : undefined,
        t("common.unexpectedError"),
      );
    }
  };

  return (
    <ReportExportRecoveryShell>
      <h2 className="font-medium">{statusTitle}</h2>

      {data.status === "failed" && (
        <p className="text-muted-foreground text-sm">
          {t("common.unexpectedError")}
        </p>
      )}

      {data.status === "completed" && data.downloadUrl && (
        <Button
          disabled={isDownloading}
          disabledReason={t("common.preparing")}
          onClick={handleDownloadClick}
        >
          {isDownloading ? t("common.preparing") : t("common.download")}
        </Button>
      )}

      {data.status === "completed" &&
        typeof data.resultEntityId === "string" && (
          <Button onClick={() => detached(handleOpen(), "reports.open")}>
            {t("workspaces.views.reportExport.openReport")}
          </Button>
        )}

      {data.status === "completed" &&
        !data.downloadUrl &&
        typeof data.resultEntityId !== "string" && (
          <p className="text-muted-foreground text-sm">
            {t("common.unexpectedError")}
          </p>
        )}
    </ReportExportRecoveryShell>
  );
}

const triggerUrlDownload = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};
