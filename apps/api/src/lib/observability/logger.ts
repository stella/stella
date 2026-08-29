import "@/api/lib/observability/otel";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const otelLogger = logs.getLogger("stella.api");
// Denylist of attribute-key substrings whose values may carry document
// content, client-identifying text, PII, or credentials, none of which
// belong in telemetry for privileged legal data. This is defense-in-depth:
// the ideal is an allowlist of known-safe keys (or value-level scrubbing),
// but a denylist is safe to extend without risking a needed metric being
// dropped — provided each substring cannot collide with a benign key. The
// credential terms are deliberately specific (`api[_-]?key`, not bare
// `token`, which would also drop `tokenCount`/`inputTokens` usage metrics).
// `prompt` is likewise narrowed with a negative lookahead so prompt CONTENT
// keys (`prompt`, `promptText`, `systemPrompt`) are redacted while usage
// metrics (`promptTokens`, `prompt_tokens`, `promptTokenCount`) survive.
const SENSITIVE_ATTRIBUTE_KEY_PATTERN =
  /(?:body|content|email|fileName|message|name|title|password|secret|credential|authorization|cookie|bearer|api[_-]?key|prompt(?!_?token)|snippet|subject|phone)/iu;

type LoggerAttributeValue = boolean | number | string;

export type LoggerAttributes = Record<string, LoggerAttributeValue>;

export type RequestErrorFingerprint = {
  errorCauseFrame?: string | undefined;
  errorClass?: string | undefined;
  errorCode?: string | undefined;
  errorFrame?: string | undefined;
  pgCode?: string | undefined;
  pgColumn?: string | undefined;
  pgConstraint?: string | undefined;
  pgRoutine?: string | undefined;
  pgSchema?: string | undefined;
  pgSeverity?: string | undefined;
  pgTable?: string | undefined;
};

type RequestLogOptions = {
  durationMs: number;
  errorFingerprint?: RequestErrorFingerprint | undefined;
  elysiaCode?: string | undefined;
  errorType?: string | undefined;
  message: "request.completed" | "request.failed";
  method: string;
  requestId?: string | undefined;
  route?: string | undefined;
  severity: "ERROR" | "INFO" | "WARN";
  statusCode: number;
};

export const sanitizeLogAttributes = (
  attributes: LoggerAttributes | undefined,
): LoggerAttributes | undefined => {
  if (!attributes) {
    return undefined;
  }

  let dropped = 0;
  const safeAttributes: LoggerAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE_ATTRIBUTE_KEY_PATTERN.test(key)) {
      dropped += 1;
      continue;
    }

    safeAttributes[key] = value;
  }

  if (dropped > 0) {
    safeAttributes["log.attributes_dropped"] = dropped;
  }

  return safeAttributes;
};

export type LogRecord = {
  readonly severityText: string;
  readonly message: string;
  readonly attributes: LoggerAttributes | undefined;
};

// Test seam: when set, every sanitized record goes here instead of to the
// OTel pipeline and the process streams, so a test reads what the real
// logger would have emitted (after attribute sanitization) without replacing
// the module.
let recordSink: ((record: LogRecord) => void) | null = null;

export const setLogSinkForTesting = (sink: (record: LogRecord) => void) => {
  recordSink = sink;
};

export const resetLogSinkForTesting = (): void => {
  recordSink = null;
};

const emit = ({
  attributes,
  message,
  severityNumber,
  severityText,
}: {
  attributes: LoggerAttributes | undefined;
  message: string;
  severityNumber: SeverityNumber;
  severityText: string;
}): void => {
  const safeAttributes = sanitizeLogAttributes(attributes);
  if (recordSink !== null) {
    recordSink({ severityText, message, attributes: safeAttributes });
    return;
  }
  const record = {
    severityNumber,
    severityText,
    body: message,
  };

  if (safeAttributes) {
    otelLogger.emit({
      ...record,
      attributes: safeAttributes,
    });
  } else {
    otelLogger.emit(record);
  }

  // Backstop for every structured record above DEBUG. The OTel pipeline
  // above exports only when a deployment opts in (see `otel.ts`), so this
  // stream is the sink operational tooling can always rely on.
  //
  // Severity answers how bad a record is. It must not also decide whether
  // anyone can ever read it: an INFO or WARN record that reaches no sink is
  // indistinguishable from one that was never emitted, and a consumer built
  // on it silently measures nothing. This previously mirrored ERROR alone,
  // which made every structured non-error event invisible in the deployed
  // runtime while looking healthy in the source.
  //
  // Payload exposure is handled one layer down: `sanitizeLogAttributes`
  // drops payload- and credential-shaped keys from every record regardless
  // of severity, so severity was never what kept payloads out. DEBUG stays
  // unmirrored as the escape hatch for hot loops.
  if (severityNumber >= SeverityNumber.INFO) {
    process.stderr.write(
      `${JSON.stringify({
        severity: severityText,
        message,
        ...safeAttributes,
      })}\n`,
    );
  }
};

const REQUEST_SEVERITY = {
  ERROR: SeverityNumber.ERROR,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
} as const;

const emitRequest = ({
  durationMs,
  elysiaCode,
  errorFingerprint,
  errorType,
  message,
  method,
  requestId,
  route,
  severity,
  statusCode,
}: RequestLogOptions): void => {
  const safeAttributes: LoggerAttributes = {
    "http.method": method,
    "http.route": route ?? "unmatched",
    "http.status_code": statusCode,
    "request.duration_ms": durationMs,
    ...(elysiaCode === undefined ? {} : { "http.elysia_code": elysiaCode }),
    ...(errorType === undefined ? {} : { "error.type": errorType }),
    ...(errorFingerprint?.errorCauseFrame === undefined
      ? {}
      : { "error.cause.frame": errorFingerprint.errorCauseFrame }),
    ...(errorFingerprint?.errorClass === undefined
      ? {}
      : { "error.class": errorFingerprint.errorClass }),
    ...(errorFingerprint?.errorCode === undefined
      ? {}
      : { "error.code": errorFingerprint.errorCode }),
    ...(errorFingerprint?.errorFrame === undefined
      ? {}
      : { "error.frame": errorFingerprint.errorFrame }),
    ...(errorFingerprint?.pgCode === undefined
      ? {}
      : { "error.cause.pg_code": errorFingerprint.pgCode }),
    ...(errorFingerprint?.pgColumn === undefined
      ? {}
      : { "error.cause.pg_column": errorFingerprint.pgColumn }),
    ...(errorFingerprint?.pgConstraint === undefined
      ? {}
      : { "error.cause.pg_constraint": errorFingerprint.pgConstraint }),
    ...(errorFingerprint?.pgRoutine === undefined
      ? {}
      : { "error.cause.pg_routine": errorFingerprint.pgRoutine }),
    ...(errorFingerprint?.pgSchema === undefined
      ? {}
      : { "error.cause.pg_schema": errorFingerprint.pgSchema }),
    ...(errorFingerprint?.pgSeverity === undefined
      ? {}
      : { "error.cause.pg_severity": errorFingerprint.pgSeverity }),
    ...(errorFingerprint?.pgTable === undefined
      ? {}
      : { "error.cause.pg_table": errorFingerprint.pgTable }),
    ...(requestId === undefined ? {} : { "request.id": requestId }),
  };

  if (recordSink !== null) {
    recordSink({ severityText: severity, message, attributes: safeAttributes });
    return;
  }
  otelLogger.emit({
    attributes: safeAttributes,
    body: message,
    severityNumber: REQUEST_SEVERITY[severity],
    severityText: severity,
  });
  process.stdout.write(
    `${JSON.stringify({ severity, message, ...safeAttributes })}\n`,
  );
};

export const logger = {
  debug: (message: string, attributes?: LoggerAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.DEBUG,
      severityText: "DEBUG",
    }),
  info: (message: string, attributes?: LoggerAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
    }),
  warn: (message: string, attributes?: LoggerAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.WARN,
      severityText: "WARN",
    }),
  error: (message: string, attributes?: LoggerAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
    }),
  request: (options: RequestLogOptions) => emitRequest(options),
};
