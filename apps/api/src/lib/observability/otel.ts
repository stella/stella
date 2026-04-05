import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";

import { env } from "@/api/env";
import { shouldEnablePostHog } from "@/api/lib/analytics/config";

const POSTHOG_LOGS_PATH = "/i/v1/logs";

const loggerProvider = shouldEnablePostHog({
  isDev: env.isDev,
  key: env.POSTHOG_KEY,
  host: env.POSTHOG_HOST,
  localDebug: env.POSTHOG_LOCAL_DEBUG,
})
  ? new LoggerProvider({
      resource: resourceFromAttributes({
        "service.name": "stella-api",
        "service.namespace": "stella",
        "deployment.environment": env.isDev ? "development" : "production",
      }),
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: new URL(POSTHOG_LOGS_PATH, env.POSTHOG_HOST).toString(),
            headers: {
              Authorization: `Bearer ${env.POSTHOG_KEY}`,
            },
          }),
        ),
      ],
    })
  : null;

if (loggerProvider) {
  logs.setGlobalLoggerProvider(loggerProvider);
}

const shutdownLoggerProvider = async (): Promise<void> => {
  if (!loggerProvider) {
    return;
  }

  await loggerProvider.forceFlush();
  await loggerProvider.shutdown();
};

if (loggerProvider) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdownLoggerProvider()
        .catch((error: unknown) => {
          const errorType =
            error instanceof Error ? error.constructor.name : "UnknownError";
          process.stderr.write(`[otel-logs] shutdown failed (${errorType})\n`);
          process.exitCode = 1;
        })
        .finally(() => process.exit());
    });
  }
}
