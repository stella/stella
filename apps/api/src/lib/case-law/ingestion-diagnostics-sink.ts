// parser-output-unchanged: structured ingestion diagnostics sink is an output-independent side effect.
/**
 * Structured logging sink for case-law ingestion diagnostics.
 *
 * Pure ingestion modules default to a no-op sink so they stay decoupled from
 * host observability and environment bootstrapping. `apps/api` registers its
 * structured logger once on module load via `registerIngestionDiagnosticsSink`.
 */
export type IngestionDiagnosticsLogFn = (
  message: string,
  attributes?: Record<string, unknown>,
) => void;

export type IngestionDiagnosticsSink = {
  info: IngestionDiagnosticsLogFn;
  warn: IngestionDiagnosticsLogFn;
  error: IngestionDiagnosticsLogFn;
};

const NOOP_LOG: IngestionDiagnosticsLogFn = () => undefined;

const NOOP_INGESTION_DIAGNOSTICS_SINK: IngestionDiagnosticsSink = {
  info: NOOP_LOG,
  warn: NOOP_LOG,
  error: NOOP_LOG,
};

let activeSink: IngestionDiagnosticsSink = NOOP_INGESTION_DIAGNOSTICS_SINK;

export const registerIngestionDiagnosticsSink = (
  sink: IngestionDiagnosticsSink,
): void => {
  activeSink = sink;
};

export const resetIngestionDiagnosticsSink = (): void => {
  activeSink = NOOP_INGESTION_DIAGNOSTICS_SINK;
};

export const getIngestionDiagnosticsSink = (): IngestionDiagnosticsSink =>
  activeSink;
