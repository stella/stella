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
    return;
  }

  otelLogger.emit(record);
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
