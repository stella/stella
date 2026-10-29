import { captureError } from "@/api/lib/analytics/capture";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";

/**
 * Registry membership for a persisted `case_law_sources.adapter_key`.
 *
 * The catalogue is history and the registry is deployment state, so the two
 * legitimately disagree: a retired adapter leaves its rows behind, and a seeded
 * or test environment carries sources no adapter was ever written for. Neither
 * is a reason to fail a read of the corpus's own status.
 *
 * What is NOT acceptable is answering silently. Every operational view here
 * keys something off the registry — remote totals, health probes — and a
 * missing entry looks exactly like a registered adapter whose probe returned
 * nothing. Reporting the row as `unrecognized` keeps the two apart in the
 * response, and the reporter below makes the disagreement visible in telemetry
 * rather than leaving it to be inferred from a hole in a table.
 */
export type SourceRegistryMembership =
  { type: "registered"; adapterKey: AdapterKey } | { type: "unrecognized" };

const isRegisteredAdapterKey = (key: string): key is AdapterKey =>
  Object.values(ADAPTER_KEYS).some((candidate) => candidate === key);

export const sourceRegistryMembership = (
  adapterKey: string,
): SourceRegistryMembership =>
  isRegisteredAdapterKey(adapterKey)
    ? { type: "registered", adapterKey }
    : { type: "unrecognized" };

export const SOURCE_REPORT_FEATURE = {
  coverage: "case_law.coverage",
  completenessCensus: "case_law.completeness_census",
  ingestionStatus: "case_law.ingestion_status",
  adapterHealth: "case_law.adapter_health",
} as const;

type SourceReportFeature =
  (typeof SOURCE_REPORT_FEATURE)[keyof typeof SOURCE_REPORT_FEATURE];

/**
 * Reports unrecognized adapter keys once per key per run.
 *
 * Per key rather than per row because the interesting fact is that a key has no
 * adapter, not how many rows carry it; per run because these views iterate the
 * whole catalogue and a retired source would otherwise report on every pass of
 * every caller. The caller builds one reporter and shares it across the rows of
 * a single read.
 */
export const createUnrecognizedSourceReporter = (
  feature: SourceReportFeature,
) => {
  const reported = new Set<string>();

  return (adapterKey: string): void => {
    if (reported.has(adapterKey)) {
      return;
    }
    reported.add(adapterKey);

    // Not a thrown error: the read succeeds and the row is reported as
    // unrecognized. This is the telemetry that keeps that from being silent.
    captureError(
      new Error(`case-law source adapter key is not registered: ${adapterKey}`),
      handlerErrorContext(`sourceRegistry.${feature}`, {
        feature,
        sourceAdapterKey: adapterKey,
      }),
    );
    logger.warn("case_law.source_adapter_key_unregistered", {
      feature,
      sourceAdapterKey: adapterKey,
    });
  };
};
