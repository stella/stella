import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";

import { envBase } from "@/api/env-base";

/**
 * External log export is opt-in per deployment: the OTLP provider registers
 * only when `LOGS_OTLP_URL` and `LOGS_OTLP_TOKEN` are both set, so
 * self-hosted installs never ship logs upstream as a side effect of other
 * telemetry configuration. Records reaching the exporter have already passed
 * `sanitizeLogAttributes`; the stderr JSON mirror in `logger.ts` stays the
 * operational sink regardless of this setting.
 */
export const isExternalLogExportEnabled =
  envBase.LOGS_OTLP_URL !== undefined && envBase.LOGS_OTLP_TOKEN !== undefined;

if (
  envBase.LOGS_OTLP_URL !== undefined &&
  envBase.LOGS_OTLP_TOKEN !== undefined
) {
  const provider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          headers: { Authorization: `Bearer ${envBase.LOGS_OTLP_TOKEN}` },
          url: envBase.LOGS_OTLP_URL,
        }),
      }),
    ],
    resource: resourceFromAttributes({
      "service.name": "stella-api",
    }),
  });
  logs.setGlobalLoggerProvider(provider);
}
