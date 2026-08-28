import type { QueryClient } from "@tanstack/react-query";

import { reportExportDetailOptions } from "@/lib/workspaces/queries/report-exports";
import { resolveCanonicalDocumentDestinationQuery } from "@/lib/workspaces/resolve-document-destination-query";

type ResolveReportExportDestinationQueryOptions = {
  exportId: string;
  queryClient: QueryClient;
  workspaceId: string;
};

/**
 * Re-read the export receipt at action time so the API remains authoritative
 * about its pinned result revision and any tombstone fallback.
 */
export const resolveReportExportDestinationQuery = async ({
  exportId,
  queryClient,
  workspaceId,
}: ResolveReportExportDestinationQueryOptions) => {
  const detail = await queryClient.query(
    reportExportDetailOptions({ exportId, workspaceId }),
  );
  if (detail.status !== "completed") {
    return null;
  }

  return await resolveCanonicalDocumentDestinationQuery({
    entityId: detail.resultEntityId,
    fieldId: detail.resultFieldId,
    queryClient,
    workspaceId,
  });
};
