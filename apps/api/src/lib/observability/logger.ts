import "@/api/lib/observability/otel";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogAttributes } from "@opentelemetry/api-logs";

const otelLogger = logs.getLogger("stella.api");

const emit = ({
  attributes,
  message,
  severityNumber,
  severityText,
}: {
  attributes: LogAttributes | undefined;
  message: string;
  severityNumber: SeverityNumber;
  severityText: string;
}): void => {
  const record = {
    severityNumber,
    severityText,
    body: message,
  };

  if (attributes) {
    otelLogger.emit({
      ...record,
      attributes,
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
        ...attributes,
      })}\n`,
    );
  }
};

export const logger = {
  debug: (message: string, attributes?: LogAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.DEBUG,
      severityText: "DEBUG",
    }),
  info: (message: string, attributes?: LogAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
    }),
  warn: (message: string, attributes?: LogAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.WARN,
      severityText: "WARN",
    }),
  error: (message: string, attributes?: LogAttributes) =>
    emit({
      message,
      attributes,
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
    }),
};
