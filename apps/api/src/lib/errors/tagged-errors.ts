import { TaggedError } from "better-result";

export type HandlerErrorStatusCode = 400 | 403 | 404 | 409 | 422 | 500 | 502;

export type HandlerErrorProps<
  TStatus extends HandlerErrorStatusCode = HandlerErrorStatusCode,
> = {
  status: TStatus;
  message: string;
  cause?: unknown;
};

// TaggedError(...) cannot reference the class type parameter in the base
// expression, so the base uses the wide props type and the subclass narrows
// `status` back down for callers.
export class HandlerError<
  TStatus extends HandlerErrorStatusCode = HandlerErrorStatusCode,
> extends TaggedError("HandlerError")<HandlerErrorProps>() {
  declare status: TStatus;

  constructor(props: HandlerErrorProps<TStatus>) {
    super(props);
    this.status = props.status;
  }
}

export class DatabaseError extends TaggedError("DatabaseError")<{
  code?: string | undefined;
  message: string;
  cause?: unknown;
}>() {}

export class DatabaseRlsError extends TaggedError("DatabaseRlsError")<{
  code?: string;
  message: string;
  cause?: unknown;
}>() {}

export class Unreachable extends TaggedError("Unreachable")<{
  message: string;
}>() {}

export const unreachable = (message: string): never => {
  throw new Unreachable({ message });
};

export class ParseXmlError extends TaggedError("ParseXmlError")<{
  message: string;
  cause: unknown;
}>() {}

export class ConfigurationError extends TaggedError("ConfigurationError")<{
  message: string;
  cause?: unknown;
}>() {}

export class TelemetryError extends TaggedError("TelemetryError")<{
  message: string;
  cause?: unknown;
}>() {}

export class HealthCheckError extends TaggedError("HealthCheckError")<{
  message: string;
  cause?: unknown;
}>() {}

/** Validation/domain-layer errors: no valid inputs, invalid config. */
export class WorkflowValidationError extends TaggedError(
  "WorkflowValidationError",
)<{
  message: string;
}>() {}

/** Chat validation failure for tool inputs, outputs, or messages. */
export class ChatToolValidationError extends TaggedError(
  "ChatToolValidationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

/** Chat tool execution failure. */
export class ChatToolError extends TaggedError("ChatToolError")<{
  message: string;
  cause?: unknown;
}>() {}

/**
 * Chat stream finished with finish_reason=stop and zero output
 * tokens. Observed with small Gemini variants (notably 2.5-flash-lite)
 * on cached prefix replays. Surfaced as a tagged error for telemetry
 * so we can track which models cause it.
 */
export class ChatEmptyCompletionError extends TaggedError(
  "ChatEmptyCompletionError",
)<{
  message: string;
}>() {}

/** Sandbox execution failure: transpile, runtime, limit, or marshalling. */
export class SandboxError extends TaggedError("SandboxError")<{
  reason:
    | "transpile"
    | "forbidden-syntax"
    | "runtime"
    | "timeout"
    | "memory"
    | "host-call-limit"
    | "return-too-large"
    | "non-serialisable-return";
  message: string;
  cause?: unknown;
}>() {}

/** Integration-layer errors: AI failures, parse failures, external I/O. */
export class WorkflowIntegrationError extends TaggedError(
  "WorkflowIntegrationError",
)<{
  message: string;
  cause?: unknown;
}>() {}

/** Post-generation OOXML structural violations. */
export class OoxmlValidationError extends TaggedError("OoxmlValidationError")<{
  message: string;
  violations: {
    rule: string;
    message: string;
    element?: string;
  }[];
}>() {}

/** DOCX tracked-changes editing failure. */
export class DocxEditError extends TaggedError("DocxEditError")<{
  message: string;
  cause: unknown;
}>() {}

/** Optimistic-lock failure inside a transaction. */
export class ConcurrentModificationError extends TaggedError(
  "ConcurrentModificationError",
)<{
  message: string;
}>() {}

/** DOCX template block-directive structural errors. */
export class TemplateDirectiveError extends TaggedError(
  "TemplateDirectiveError",
)<{
  message: string;
  errors: {
    message: string;
    paragraphIndex: number;
    directive: string;
  }[];
}>() {}

/** Case-law adapter page-fetch failure. */
export class AdapterFetchError extends TaggedError("AdapterFetchError")<{
  message: string;
  adapterKey: string;
  cursor: string | null;
  httpStatus?: number;
  cause?: unknown;
}>() {}

/** Subprocess execution failure. */
export class SubprocessError extends TaggedError("SubprocessError")<{
  message: string;
  exitCode: number | null;
  cause?: unknown;
}>() {}

/** File content extraction failure. */
export class ExtractionWorkerError extends TaggedError(
  "ExtractionWorkerError",
)<{
  message: string;
  exitCode: number | null;
}>() {}
