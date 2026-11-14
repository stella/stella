import { Result } from "better-result";

import { startWebHangDetector } from "@/lib/analytics/web-hang/web-hang-detector";

type ClientBootstrapOptions = {
  loadRuntime: () => Promise<unknown>;
  captureDetectorError: (error: unknown) => void;
};

/** Detector telemetry cannot prevent loading the application's runtime. */
export const bootClientRuntime = async ({
  loadRuntime,
  captureDetectorError,
}: ClientBootstrapOptions): Promise<void> => {
  const detectorStartup = startWebHangDetector();
  await loadRuntime();
  if (Result.isError(detectorStartup)) {
    captureDetectorError(detectorStartup.error);
  }
};
