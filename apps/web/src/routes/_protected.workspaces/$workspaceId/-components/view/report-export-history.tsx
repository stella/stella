import { useState } from "react";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import {
  REPORT_EXPORTS_PAGE_SIZE,
  reportExportsHistoryOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/report-exports";

import { downloadReportExport } from "./report-export-actions";
import type { ReportExportDeliveryMode } from "./report-export-tracking";

type ReportExportHistoryProps = {
  workspaceId: string;
};

export const ReportExportHistory = ({
  workspaceId,
}: ReportExportHistoryProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery(
    reportExportsHistoryOptions({
      limit: REPORT_EXPORTS_PAGE_SIZE,
      workspaceId,
    }),
  );
  const reportExports =
    data === undefined ? [] : data.pages.flatMap((page) => page.items);

  const handleDownload = async (exportId: string) => {
    setActiveActionId(exportId);
    const result = await Result.tryPromise(async () => {
      await downloadReportExport({ exportId, queryClient, workspaceId });
    });
    setActiveActionId(null);
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("workspaces.views.reportExport.failed"),
        description: t("common.unexpectedError"),
      });
    }
  };

  const handleOpen = async (entityId: string) => {
    setActiveActionId(entityId);
    const result = await Result.tryPromise(
      async () =>
        await navigate({
          to: "/workspaces/$workspaceId/entities/$entityId",
          params: { workspaceId, entityId },
        }),
    );
    setActiveActionId(null);
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
    }
  };

  const handleDownloadClick = (exportId: string) => {
    handleDownload(exportId).catch((error: unknown) =>
      analytics.captureError(error),
    );
  };

  const handleOpenClick = (entityId: string) => {
    handleOpen(entityId).catch((error: unknown) =>
      analytics.captureError(error),
    );
  };

  let content = (
    <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
  );
  if (isLoading) {
    content = (
      <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
    );
  } else if (isError) {
    content = (
      <p className="text-destructive text-sm">{t("common.unexpectedError")}</p>
    );
  } else if (reportExports.length > 0) {
    content = (
      <ul className="divide-y">
        {reportExports.map((reportExport) => (
          <li
            className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            key={reportExport.id}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t(REPORT_EXPORT_STATUS_KEYS[reportExport.status])}
              </p>
              <p className="text-muted-foreground text-xs">
                {t(REPORT_EXPORT_MODE_KEYS[reportExport.mode])}
                {" · "}
                {format.dateTime(new Date(reportExport.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </div>
            <ReportExportHistoryAction
              activeActionId={activeActionId}
              onDownload={handleDownloadClick}
              onOpen={handleOpenClick}
              reportExport={reportExport}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section
      aria-labelledby="report-export-history-heading"
      className="border-t pt-4"
    >
      <h3
        className="mb-2 text-sm font-medium"
        id="report-export-history-heading"
      >
        {t("common.history")}
      </h3>
      {content}
      {hasNextPage && (
        <Button
          className="mt-2 w-full"
          disabled={isFetchingNextPage}
          onClick={() => {
            fetchNextPage().catch((error: unknown) =>
              analytics.captureError(error),
            );
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </section>
  );
};

type ReportExportStatus = "queued" | "running" | "completed" | "failed";

const REPORT_EXPORT_STATUS_KEYS = {
  queued: "common.preparing",
  running: "common.running",
  completed: "workspaces.views.reportExport.completed",
  failed: "workspaces.views.reportExport.failed",
} as const satisfies Record<ReportExportStatus, TranslationKey>;

const REPORT_EXPORT_MODE_KEYS = {
  workspace: "templates.moveToMatter",
  download: "common.download",
} as const satisfies Record<ReportExportDeliveryMode, TranslationKey>;

type ReportExportHistoryActionProps = {
  activeActionId: string | null;
  onDownload: (exportId: string) => void;
  onOpen: (entityId: string) => void;
  reportExport: {
    id: string;
    mode: ReportExportDeliveryMode;
    resultEntityId: string | null;
    status: ReportExportStatus;
  };
};

const ReportExportHistoryAction = ({
  activeActionId,
  onDownload,
  onOpen,
  reportExport,
}: ReportExportHistoryActionProps) => {
  const t = useTranslations();
  if (reportExport.status !== "completed") {
    return null;
  }

  if (reportExport.mode === "download") {
    return (
      <Button
        disabled={activeActionId === reportExport.id}
        onClick={() => {
          onDownload(reportExport.id);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        {t("common.download")}
      </Button>
    );
  }

  if (reportExport.resultEntityId === null) {
    return null;
  }
  const resultEntityId = reportExport.resultEntityId;

  return (
    <Button
      disabled={activeActionId === resultEntityId}
      onClick={() => {
        onOpen(resultEntityId);
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {t("workspaces.views.reportExport.openReport")}
    </Button>
  );
};
