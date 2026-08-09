// Passive regression fixture for `no-raw-error-logging/no-raw-error-logging`.

declare const error: { cause: unknown; message: string; stack: string };
declare const errorTag: (value: unknown) => string;
declare const logger: {
  error: (event: string, attributes: Record<string, unknown>) => void;
  warn: (event: string, attributes: Record<string, unknown>) => void;
};

// oxlint-disable-next-line no-raw-error-logging/no-raw-error-logging -- fixture proves raw error attributes are rejected
logger.error("worker.failed", { error: error.message });
// oxlint-disable-next-line no-raw-error-logging/no-raw-error-logging -- fixture proves explicit raw error keys are rejected even through member access
logger.warn("request.failed", { "error.message": error.message });
// oxlint-disable-next-line no-raw-error-logging/no-raw-error-logging -- fixture proves stderr templates cannot expose raw error details
process.stderr.write(`worker failed: ${error.stack}\n`);

logger.error("worker.failed", { "error.type": errorTag(error) });
process.stderr.write("worker failed: TaggedFailure\n");
