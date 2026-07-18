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

  // Stdout backstop for ERROR records. The OTel pipeline above
  // can be wired to a remote exporter later; until it is, this
  // mirrors ERROR records to stdout so incidents are debuggable
  // from the runtime's standard log stream. ERROR-only by
  // default keeps volume small and avoids surfacing request
  // payloads that might appear at lower severities.
  if (severityNumber === SeverityNumber.ERROR) {
    process.stderr.write(
      `${JSON.stringify({
        severity: severityText,
        message,
        ...safeAttributes,
      })}\n`,
    );
  }
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
};
