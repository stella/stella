import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { stellaToast } from "@stll/ui/components/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { APIError } from "@/lib/errors/api";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  reportExportDetailOptions,
  reportExportsKeys,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/report-exports";

import { downloadReportExport } from "./report-export-actions";
import {
  takeReportExportToast,
  useReportExportTrackingStore,
} from "./report-export-tracking";
import { trackedExportsForRequester } from "./report-export-tracking.logic";

const POLL_INTERVAL_MS = 2000;

type ReportExportTrackerProps = {
  workspaceId: string;
};

export const ReportExportTracker = ({
  workspaceId,
}: ReportExportTrackerProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const requestedBy = useRouteContext({
    from: "/_protected",
    select: (context) => context.user.id,
  });
  const trackedExports = useReportExportTrackingStore(
    useShallow((state) =>
      trackedExportsForRequester(state.exports, requestedBy, workspaceId),
    ),
  );
  const results = useQueries({
    queries: trackedExports.map((reportExport) => ({
      ...reportExportDetailOptions({
        exportId: reportExport.exportId,
        workspaceId: reportExport.workspaceId,
      }),
      refetchInterval: POLL_INTERVAL_MS,
      refetchOnWindowFocus: false,
      gcTime: 0,
    })),
  });
  const settledIndex = results.findIndex(
    ({ data, error }) =>
      data?.status === "completed" ||
      data?.status === "failed" ||
      (APIError.is(error) && error.status === 404),
  );
  const settledExport =
    settledIndex === -1 ? undefined : trackedExports.at(settledIndex);
  const settledDetail =
    settledIndex === -1 ? undefined : results.at(settledIndex)?.data;

  useExternalSyncEffect(() => {
    if (settledIndex === -1 || settledExport === undefined) {
      return;
    }

    useReportExportTrackingStore.getState().finish(settledExport.exportId);
    const toastId = takeReportExportToast(settledExport.exportId);
    queryClient
      .invalidateQueries({
        queryKey: reportExportsKeys.all(settledExport.workspaceId),
      })
      .catch((error: unknown) => analytics.captureError(error));

    if (settledDetail === undefined) {
      const toast = {
        type: "error" as const,
        title: t("workspaces.views.reportExport.failed"),
        description: t("common.unexpectedError"),
      };
      if (toastId === undefined) {
        stellaToast.add(toast);
      } else {
        stellaToast.update(toastId, toast);
      }
      return;
    }

    if (settledDetail.status === "failed") {
      const toast = {
        type: "error" as const,
        title: t("workspaces.views.reportExport.failed"),
        description: t("common.unexpectedError"),
      };
      if (toastId === undefined) {
        stellaToast.add(toast);
      } else {
        stellaToast.update(toastId, toast);
      }
      return;
    }

    if (
      settledExport.mode === "download" &&
      settledDetail.downloadUrl !== null
    ) {
      const handleDownload = async () => {
        const result = await Result.tryPromise(async () => {
          await downloadReportExport({
            exportId: settledExport.exportId,
            queryClient,
            workspaceId: settledExport.workspaceId,
          });
        });
        if (Result.isError(result)) {
          analytics.captureError(result.error);
          stellaToast.add({
            type: "error",
            title: t("workspaces.views.reportExport.failed"),
            description: t("common.unexpectedError"),
          });
        }
      };
      const toast = {
        type: "success" as const,
        title: t("workspaces.views.reportExport.completed"),
        action: {
          label: t("common.download"),
          onClick: () => {
            handleDownload().catch((error: unknown) =>
              analytics.captureError(error),
            );
          },
        },
      };
      if (toastId === undefined) {
        stellaToast.add(toast);
      } else {
        stellaToast.update(toastId, toast);
      }
      return;
    }

    if (settledDetail.resultEntityId !== null) {
      const resultEntityId = settledDetail.resultEntityId;
      queryClient
        .invalidateQueries({
          queryKey: entitiesKeys.all(settledExport.workspaceId),
        })
        .catch((error: unknown) => analytics.captureError(error));
      const handleOpen = async () => {
        const result = await Result.tryPromise(
          async () =>
            await navigate({
              to: "/workspaces/$workspaceId/entities/$entityId",
              params: {
                workspaceId: settledExport.workspaceId,
                entityId: resultEntityId,
              },
            }),
        );
        if (Result.isError(result)) {
          analytics.captureError(result.error);
          stellaToast.add({
            type: "error",
            title: t("common.unexpectedError"),
          });
        }
      };
      const toast = {
        type: "success" as const,
        title: t("workspaces.views.reportExport.completed"),
        action: {
          label: t("workspaces.views.reportExport.openReport"),
          onClick: () => {
            handleOpen().catch((error: unknown) =>
              analytics.captureError(error),
            );
          },
        },
      };
      if (toastId === undefined) {
        stellaToast.add(toast);
      } else {
        stellaToast.update(toastId, toast);
      }
      return;
    }

    const toast = {
      type: "error" as const,
      title: t("workspaces.views.reportExport.failed"),
      description: t("common.unexpectedError"),
    };
    if (toastId === undefined) {
      stellaToast.add(toast);
    } else {
      stellaToast.update(toastId, toast);
    }
  }, [
    analytics,
    navigate,
    queryClient,
    t,
    settledDetail,
    settledExport,
    settledIndex,
  ]);

  return null;
};
