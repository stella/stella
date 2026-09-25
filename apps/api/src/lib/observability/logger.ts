import "@/api/lib/observability/otel";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

import type { FailureGrade, FailureReason } from "@stll/errors";
import { FAILURE_GRADES, isFailureReason } from "@stll/errors";

import type { ErrorFingerprint } from "@/api/lib/errors/utils";
import { SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN } from "@/api/lib/observability/log-attribute-policy";

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
// The pattern itself lives in `log-attribute-policy.ts` so the lint rule that
// rejects such keys at the call site can pin the same one.
const SENSITIVE_ATTRIBUTE_KEY_PATTERN = SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN;

type LoggerAttributeValue = boolean | number | string;

export type LoggerAttributes = Record<string, LoggerAttributeValue>;

/** The request's graded failure, from the request's failure observation. */
type RequestLogFailure = {
  readonly grade: FailureGrade;
  readonly reason: FailureReason;
};

type RequestLogOptions = {
  clientAddressSource?: string | undefined;
  durationMs: number;
  errorFingerprint?: ErrorFingerprint | undefined;
  elysiaCode?: string | undefined;
  errorType?: string | undefined;
  failure?: RequestLogFailure | undefined;
  message: "request.completed" | "request.failed";
  method: string;
  requestId?: string | undefined;
  route?: string | undefined;
  severity: "ERROR" | "INFO" | "WARN";
  statusCode: number;
};

// The failure classifier's own keys hold a closed vocabulary. A value outside
// it is not a grade, and free text riding under an owned key would be exactly
// the payload the key names were chosen to exclude.
const FAILURE_GRADE_KEYS: ReadonlySet<string> = new Set([
  "failure.grade",
  "failure.shadow_grade",
]);
const FAILURE_REASON_KEYS: ReadonlySet<string> = new Set([
  "failure.reason",
  "failure.shadow_reason",
]);

const isFailureGrade = (value: unknown): boolean =>
  FAILURE_GRADES.some((grade) => grade === value);

const isOwnedValueValid = (
  key: string,
  value: LoggerAttributeValue,
): boolean => {
  if (FAILURE_GRADE_KEYS.has(key)) {
    return isFailureGrade(value);
  }
  if (FAILURE_REASON_KEYS.has(key)) {
    return isFailureReason(value);
  }
  return true;
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
    if (
      SENSITIVE_ATTRIBUTE_KEY_PATTERN.test(key) ||
      !isOwnedValueValid(key, value)
    ) {
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

const ERROR_ATTRIBUTE_PREFIX = "error.";
const OWNED_FAILURE_KEY = "failure.grade";
const UNOWNED_KEY = "observability.unowned";

/**
 * Mark a WARN or ERROR record that describes an error without a failure
 * grade: a sink the failure owner has not reached yet, countable from the
 * deployed log stream.
 */
const annotateUnowned = (
  severityNumber: SeverityNumber,
  attributes: LoggerAttributes | undefined,
): LoggerAttributes | undefined => {
  if (
    attributes === undefined ||
    severityNumber < SeverityNumber.WARN ||
    Object.hasOwn(attributes, OWNED_FAILURE_KEY) ||
    !Object.keys(attributes).some((key) =>
      key.startsWith(ERROR_ATTRIBUTE_PREFIX),
    )
  ) {
    return attributes;
  }
  return { ...attributes, [UNOWNED_KEY]: true };
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
  const safeAttributes = annotateUnowned(
    severityNumber,
    sanitizeLogAttributes(attributes),
  );
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
  clientAddressSource,
  durationMs,
  elysiaCode,
  errorFingerprint,
  errorType,
  failure,
  message,
  method,
  requestId,
  route,
  severity,
  statusCode,
}: RequestLogOptions): void => {
  const safeAttributes = annotateUnowned(REQUEST_SEVERITY[severity], {
    // The fingerprint's keys are already this sink's attribute names, so the
    // record ships whole rather than being re-listed field by field. A second
    // copy of that key set can only ever be a shorter one, and a field it
    // leaves out is a field no reader of this sink can get back. It goes
    // first, so none of its keys can override the request's own.
    ...sanitizeLogAttributes(errorFingerprint),
    "http.method": method,
    "http.route": route ?? "unmatched",
    "http.status_code": statusCode,
    "request.duration_ms": durationMs,
    ...(elysiaCode === undefined ? {} : { "http.elysia_code": elysiaCode }),
    ...(errorType === undefined ? {} : { "error.type": errorType }),
    ...(requestId === undefined ? {} : { "request.id": requestId }),
    ...(clientAddressSource === undefined
      ? {}
      : { "client.address_source": clientAddressSource }),
    ...(failure === undefined
      ? {}
      : {
          "failure.grade": failure.grade,
          "failure.reason": failure.reason,
          "failure.shadow": "true",
        }),
  });

  if (recordSink !== null) {
    recordSink({ severityText: severity, message, attributes: safeAttributes });
    return;
  }
  otelLogger.emit({
    ...(safeAttributes === undefined ? {} : { attributes: safeAttributes }),
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
