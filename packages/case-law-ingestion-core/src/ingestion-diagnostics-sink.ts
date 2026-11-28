// parser-output-unchanged: structured ingestion diagnostics sink is an output-independent side effect.
/**
 * Structured logging and failure-observation sink for case-law ingestion diagnostics.
 *
 * Pure ingestion modules default to a no-op sink so they stay decoupled from
 * host observability and environment bootstrapping. `apps/api` registers its
 * structured logger once on module load via `registerIngestionDiagnosticsSink`
 * and its failure observer via `registerIngestionFailureObserver`.
 */
export type IngestionDiagnosticsLogFn = (
  message: string,
  attributes?: Record<string, unknown>,
) => void;

export type IngestionFailureInput = {
  readonly event: string;
  readonly ctx?: Record<string, unknown> | undefined;
};

export type IngestionFailureObserver = (
  error: unknown,
  input: IngestionFailureInput,
) => void;

export type IngestionDiagnosticsLogger = {
  info: IngestionDiagnosticsLogFn;
  warn: IngestionDiagnosticsLogFn;
  error: IngestionDiagnosticsLogFn;
};

export type IngestionDiagnosticsSink = IngestionDiagnosticsLogger & {
  observeFailure: IngestionFailureObserver;
};

const NOOP_LOG: IngestionDiagnosticsLogFn = () => undefined;
const NOOP_OBSERVE_FAILURE: IngestionFailureObserver = () => undefined;

const NOOP_INGESTION_DIAGNOSTICS_LOGGER: IngestionDiagnosticsLogger = {
  info: NOOP_LOG,
  warn: NOOP_LOG,
  error: NOOP_LOG,
};

let activeLogger: IngestionDiagnosticsLogger =
  NOOP_INGESTION_DIAGNOSTICS_LOGGER;
let activeFailureObserver: IngestionFailureObserver = NOOP_OBSERVE_FAILURE;

// Delegate through the active references so test spies patched onto a
// registered logger instance continue to intercept diagnostic calls.
const ACTIVE_SINK: IngestionDiagnosticsSink = {
  info: (message, attributes) => {
    activeLogger.info(message, attributes);
  },
  warn: (message, attributes) => {
    activeLogger.warn(message, attributes);
  },
  error: (message, attributes) => {
    activeLogger.error(message, attributes);
  },
  observeFailure: (error, input) => {
    activeFailureObserver(error, input);
  },
};

export const registerIngestionDiagnosticsSink = (
  sink: IngestionDiagnosticsLogger & {
    observeFailure?: IngestionFailureObserver | undefined;
  },
): void => {
  activeLogger = sink;
  if (sink.observeFailure !== undefined) {
    activeFailureObserver = sink.observeFailure;
  }
};

export const registerIngestionFailureObserver = (
  observer: IngestionFailureObserver,
): void => {
  activeFailureObserver = observer;
};

export const getIngestionDiagnosticsSink = (): IngestionDiagnosticsSink =>
  ACTIVE_SINK;
