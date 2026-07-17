import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
  const trackedExports = useReportExportTrackingStore(
    useShallow((state) =>
      Object.values(state.exports).filter(
        (reportExport) => reportExport.workspaceId === workspaceId,
      ),
    ),
  );
  const results = useQueries({
    queries: trackedExports.map((reportExport) => ({
      ...reportExportDetailOptions({
        exportId: reportExport.exportId,
        workspaceId: reportExport.workspaceId,
      }),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status === "completed" || status === "failed") {
          return false;
        }
        return POLL_INTERVAL_MS;
      },
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
    settledIndex < 0 ? undefined : trackedExports.at(settledIndex);
  const settledDetail =
    settledIndex < 0 ? undefined : results.at(settledIndex)?.data;

  useExternalSyncEffect(() => {
    if (settledIndex < 0 || settledExport === undefined) {
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
      if (toastId !== undefined) {
        stellaToast.update(toastId, {
          type: "error",
          title: t("workspaces.views.reportExport.failed"),
          description: t("common.unexpectedError"),
        });
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

    if (settledExport.mode === "download") {
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
            void handleDownload();
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
            void handleOpen();
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
