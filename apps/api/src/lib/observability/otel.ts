// parser-output-unchanged: Release attribution adds a service.version attribute to telemetry records; parsed ingestion records are unchanged.
import { envBase } from "@/api/env-base";
import {
  createOtlpLogExporter,
  type OtlpLogExporter,
  type OtlpLogExportFailure,
} from "@/api/lib/observability/otlp-log-exporter";
import { APP_VERSION, SERVICE_VERSION_KEY } from "@/api/lib/version";

/**
 * An export failure goes straight to stderr in the logger's line format. It
 * cannot go through the logger: that would queue another record on the
 * exporter that just failed and feed the failure back into itself.
 */
const reportExportFailure = (failure: OtlpLogExportFailure): void => {
  const { kind, ...details } = failure;
  process.stderr.write(
    `${JSON.stringify({
      severity: "WARN",
      message: "logs.export_failed",
      "logs.export.failure": kind,
      ...Object.fromEntries(
        Object.entries(details).map(([key, value]) => [
          `logs.export.${key}`,
          value,
        ]),
      ),
      [SERVICE_VERSION_KEY]: APP_VERSION,
    })}\n`,
  );
};

/**
 * External log export is opt-in per deployment: the OTLP exporter exists only
 * when `LOGS_OTLP_URL` and `LOGS_OTLP_TOKEN` are both set, so self-hosted
 * installs never ship logs upstream as a side effect of other telemetry
 * configuration. Records reaching the exporter have already passed
 * `sanitizeLogAttributes`; the stderr JSON mirror in `logger.ts` stays the
 * operational sink regardless of this setting.
 */
export const otlpLogExporter: OtlpLogExporter | null =
  envBase.LOGS_OTLP_URL !== undefined && envBase.LOGS_OTLP_TOKEN !== undefined
    ? createOtlpLogExporter({
        headers: {
          Authorization: `Bearer ${envBase.LOGS_OTLP_TOKEN}`,
          "User-Agent": `stella-api/${APP_VERSION}`,
        },
        onFailure: reportExportFailure,
        resource: {
          "service.name": "stella-api",
          [SERVICE_VERSION_KEY]: APP_VERSION,
        },
        scopeName: "stella.api",
        url: envBase.LOGS_OTLP_URL,
      })
    : null;

/** Export every queued log record; a no-op when export is not configured. */
export const flushLogExport = async (): Promise<void> => {
  await otlpLogExporter?.flush();
};
