import { useState } from "react";

import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

function ReportExportRecoveryPage() {
  const t = useTranslations();
  const analytics = useAnalytics();
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
    void handleDownload().catch((error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
    });
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

          {data.status === "completed" && data.resultEntityId && (
            <Button
              render={
                <Link
                  from="/workspaces/$workspaceId/reports/$exportId"
                  params={{ entityId: data.resultEntityId, workspaceId }}
                  to="/workspaces/$workspaceId/entities/$entityId"
                />
              }
            >
              {t("workspaces.views.reportExport.openReport")}
            </Button>
          )}

          {data.status === "completed" &&
            !data.downloadUrl &&
            !data.resultEntityId && (
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
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
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
