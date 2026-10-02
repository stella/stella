// Application logging initializes optional export; database-only callers use the core.
import "./otel";

export {
  logger,
  resetLogSinkForTesting,
  sanitizeLogAttributes,
  setLogSinkForTesting,
} from "./logger-core";
export type { LoggerAttributes, LogRecord } from "./logger-core";
