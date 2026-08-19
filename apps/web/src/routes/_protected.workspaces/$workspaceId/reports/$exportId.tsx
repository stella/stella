import { useState } from "react";

import {
  queryOptions,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { resolveReportExportDestinationQuery } from "@/lib/workspaces/resolve-report-export-destination-query";

function ReportExportRecoveryPage() {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { exportId, workspaceId } = Route.useParams({
    select: (params) => ({
      exportId: params.exportId,
      workspaceId: params.workspaceId,
    }),
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const { data, refetch } = useSuspenseQuery(
    reportExportRecoveryOptions({ exportId, workspaceId }),
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
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
      return;
    }

    const downloadUrl = result.value.data?.downloadUrl;
    if (!downloadUrl) {
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
      return;
    }

    triggerUrlDownload(downloadUrl);
  };

  const handleDownloadClick = () => {
    detached(
      handleDownload().catch((error: unknown) => {
        analytics.captureError(error);
        stellaToast.add({
          type: "error",
          title: t("common.unexpectedError"),
        });
      }),
      "reports.download",
    );
  };

  const handleOpen = async () => {
    const result = await Result.tryPromise(async () => {
      const destination = await resolveReportExportDestinationQuery({
        exportId,
        queryClient,
        workspaceId,
      });
      if (destination === null) {
        return null;
      }
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId: "all" },
        search: {
          entity: destination.entityId,
          field: destination.fieldId,
        },
      });
      return destination;
    });
    if (Result.isError(result) || result.value === null) {
      if (Result.isError(result)) {
        analytics.captureError(result.error);
      }
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
    }
  };

  return (
    <main className="flex h-full flex-col">
      <header className="border-b px-4 py-3">
        <h1 className="text-sm font-medium">
          {t("workspaces.views.reportExport.title")}
        </h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <section
          aria-live="polite"
          className="mx-auto flex max-w-lg flex-col gap-3 rounded-lg border p-5"
        >
          <h2 className="font-medium">{statusTitle}</h2>

          {data.status === "failed" && (
            <p className="text-muted-foreground text-sm">
              {t("common.unexpectedError")}
            </p>
          )}

          {data.status === "completed" && data.downloadUrl && (
            <Button disabled={isDownloading} onClick={handleDownloadClick}>
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
        </section>
      </div>
    </main>
  );
}

function ReportExportRecoverySkeleton() {
  return (
    <main className="flex h-full flex-col">
      <header className="border-b px-4 py-3">
        <Skeleton className="h-5 w-28" />
      </header>
      <div className="flex-1 p-6">
        <section className="mx-auto flex max-w-lg flex-col gap-3 rounded-lg border p-5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-9 w-full" />
        </section>
      </div>
    </main>
  );
}

const POLL_INTERVAL_MS = 2000;

type ReportExportRecoveryKey = {
  exportId: string;
  workspaceId: string;
};

const reportExportRecoveryKeys = {
  all: (workspaceId: string) =>
    ["report-export-recovery", workspaceId] as const,
  detail: ({ exportId, workspaceId }: ReportExportRecoveryKey) =>
    [...reportExportRecoveryKeys.all(workspaceId), exportId] as const,
};

const reportExportRecoveryOptions = ({
  exportId,
  workspaceId,
}: ReportExportRecoveryKey) =>
  queryOptions({
    queryKey: reportExportRecoveryKeys.detail({ exportId, workspaceId }),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .reports({ exportId: toSafeId<"reportExport">(exportId) })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
    staleTime: 0,
  });

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/reports/$exportId",
)({
  component: ReportExportRecoveryPage,
  loader: async ({ context, params }) => {
    await ensureRouteQueryData(
      context.queryClient,
      reportExportRecoveryOptions(params),
    );
  },
  pendingComponent: ReportExportRecoverySkeleton,
});

const triggerUrlDownload = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};
