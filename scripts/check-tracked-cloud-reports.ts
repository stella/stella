import path from "node:path";

class TrackedCloudReportInvariantError extends Error {
  override name = "TrackedCloudReportInvariantError";
  readonly _tag = "TrackedCloudReportInvariantError";
}

const readTrackedPaths = async (root: string) => {
  const child = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new TrackedCloudReportInvariantError(
      JSON.stringify({ message: "Cannot read tracked paths", stderr }),
    );
  }
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split("\0")
    .filter((trackedPath) => trackedPath !== "");
};

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
