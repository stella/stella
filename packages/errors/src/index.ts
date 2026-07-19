import { TaggedError } from "better-result";

export {
  createDevErrorLogger,
  type CreateDevErrorLoggerOptions,
  type DevErrorSink,
} from "./dev-error";

/**
 * HTTP/network failure at a raw fetch boundary. Carries protocol details for
 * structured logging while keeping callers free to wrap user-facing messages.
 */
export class FetchBoundaryError extends TaggedError("FetchBoundaryError")<{
  url: string;
  status?: number;
  statusText?: string;
  body?: string;
  message: string;
  cause?: unknown;
}>() {}
