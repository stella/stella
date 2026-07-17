import type { QueryClient } from "@tanstack/react-query";

import { APIError } from "@/lib/errors/api";
import { reportExportDetailOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/report-exports";

type DownloadReportExportOptions = {
  exportId: string;
  queryClient: QueryClient;
  workspaceId: string;
};

export const downloadReportExport = async ({
  exportId,
  queryClient,
  workspaceId,
}: DownloadReportExportOptions) => {
  const detail = await queryClient.fetchQuery(
    reportExportDetailOptions({ exportId, workspaceId }),
  );
  if (detail.status !== "completed" || detail.downloadUrl === null) {
    throw new APIError({
      status: 409,
      message: "Report export is not ready to download",
    });
  }

  const link = document.createElement("a");
  link.href = detail.downloadUrl;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};
