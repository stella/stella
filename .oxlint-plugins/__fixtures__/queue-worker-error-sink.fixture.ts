// Passive regression fixture for
// `queue-worker-error-sink/queue-worker-error-sink`.
//
// Each violation below is a way a worker `error` handler can reintroduce the
// unbounded run. The two named-sink cases are the ones a source scan misses,
// which is why this rule reads the AST.

declare const logger: {
  error: (event: string, fields?: Record<string, string>) => void;
  warn: (event: string, fields?: Record<string, string>) => void;
};
declare const worker: {
  on: (event: string, handler: (error: unknown) => void) => void;
};
declare const createQueueWorkerErrorLogger: (
  event: string,
  fields?: Record<string, string>,
) => (error: unknown) => void;
declare const connectionErrorFields: (error: unknown) => Record<string, string>;

worker.on("error", (error) => {
  // oxlint-disable-next-line queue-worker-error-sink/queue-worker-error-sink -- fixture proves a direct log inside the handler is rejected
  logger.error("file_derivative.worker_error", connectionErrorFields(error));
});

const WORKER_ERROR_EVENT = "document_review_run.worker_error";

// The evasion a source regex cannot see: the name is a binding, not a literal.
worker.on("error", (error) => {
  // oxlint-disable-next-line queue-worker-error-sink/queue-worker-error-sink -- fixture proves an event name held in a constant is still rejected
  logger.error(WORKER_ERROR_EVENT, connectionErrorFields(error));
});

// A sink named outside any handler is equally unbounded once it is registered.
const logWorkerErrorDirectly = (error: unknown): void => {
  // oxlint-disable-next-line queue-worker-error-sink/queue-worker-error-sink -- fixture proves a named sink outside the callback is rejected
  logger.error(WORKER_ERROR_EVENT, connectionErrorFields(error));
};

// Accepted: the handler is the throttled helper.
worker.on("error", createQueueWorkerErrorLogger("flow.worker_error"));

// Accepted: a handler may branch and delegate, as long as it does not log the
// worker error itself. This is the shape `workflow-queue` uses for the
// recoverable poll blip.
const delegated = createQueueWorkerErrorLogger("workflow.worker_error");
worker.on("error", (error) => {
  if (error === null) {
    logger.warn("workflow.worker_redis_poll_blip");
    return;
  }
  delegated(error);
});

void logWorkerErrorDirectly;
