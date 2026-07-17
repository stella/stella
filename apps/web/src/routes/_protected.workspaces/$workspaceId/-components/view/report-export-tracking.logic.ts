export type ReportExportDeliveryMode = "workspace" | "download";

export type TrackedReportExport = {
  exportId: string;
  mode: ReportExportDeliveryMode;
  requestedBy: string;
  trackedAt: number;
  workspaceId: string;
};

const MAX_TRACKED_EXPORTS = 100;

export const retainNewestTrackedExports = (
  trackedExports: TrackedReportExport[],
): Record<string, TrackedReportExport> => {
  const exports: Record<string, TrackedReportExport> = {};
  let retainedCount = 0;
  for (const reportExport of trackedExports.toSorted(
    (left, right) => right.trackedAt - left.trackedAt,
  )) {
    if (reportExport.exportId in exports) {
      continue;
    }
    exports[reportExport.exportId] = reportExport;
    retainedCount += 1;
    if (retainedCount === MAX_TRACKED_EXPORTS) {
      break;
    }
  }
  return exports;
};

export const nextTrackedAt = (
  trackedExports: Record<string, TrackedReportExport>,
  now: number,
): number => {
  let trackedAt = now;
  for (const reportExport of Object.values(trackedExports)) {
    if (reportExport.trackedAt >= trackedAt) {
      trackedAt = reportExport.trackedAt + 1;
    }
  }
  return trackedAt;
};

export const trackedExportsForRequester = (
  trackedExports: Record<string, TrackedReportExport>,
  requestedBy: string,
  workspaceId: string,
): TrackedReportExport[] =>
  Object.values(trackedExports).filter(
    (reportExport) =>
      reportExport.requestedBy === requestedBy &&
      reportExport.workspaceId === workspaceId,
  );
