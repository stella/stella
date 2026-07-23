type ExtractionRunProgressState = {
  status: string;
  total: number;
};

export const hasActiveExtractionProgress = (
  run: ExtractionRunProgressState | null,
): run is ExtractionRunProgressState =>
  run !== null &&
  run.total > 0 &&
  (run.status === "planning" ||
    run.status === "running" ||
    run.status === "finalizing");
