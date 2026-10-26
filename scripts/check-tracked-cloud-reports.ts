import path from "node:path";

import { readTrackedPaths } from "./tracked-paths";

export const trackedCloudReports = async (root: string) =>
  (await readTrackedPaths(root)).filter(
    (trackedPath) =>
      path.posix.basename(trackedPath).toLowerCase() === "cloud_report.md",
  );

if (import.meta.main) {
  const reports = await trackedCloudReports(process.cwd());
  for (const report of reports) {
    console.error(`Tracked cloud task report: ${JSON.stringify(report)}`);
  }
  if (reports.length > 0) {
    process.exitCode = 1;
  }
}
