import { panic, Result } from "better-result";

import { errorTag } from "@/api/lib/errors/error-tag";
import type {
  IngestionResult,
  SourceFieldInventory,
} from "@/api/lib/legal-search/ingestion-types";
import { publisherFieldRetentionAudit } from "@/api/lib/legal-search/source-exclusion-census";
import {
  decodeSourceRawEnvelope,
  type SourceRawParts,
} from "@/api/lib/legal-search/source-raw-envelope";
import type { logger } from "@/api/lib/observability/logger";

export const PUBLISHER_FIELD_COVERAGE_EVENT = {
  UNMAPPED: "case_law.ingestion.publisher_fields_unmapped",
  READER_FAILED: "case_law.ingestion.publisher_field_reader_failed",
} as const;

type RetainedPublisherPartsOptions = {
  adapterKey: string;
  result: Pick<IngestionResult, "sourceRaw" | "sourceRawBytes">;
};

/** A binary main payload would overwrite the envelope in the raw writer. */
export const retainedPublisherParts = ({
  adapterKey,
  result,
}: RetainedPublisherPartsOptions): SourceRawParts => {
  if (result.sourceRawBytes !== undefined) {
    return panic(
      `${adapterKey}: publisher responses must use an envelope with named binary objects`,
    );
  }
  const parts =
    result.sourceRaw === undefined
      ? null
      : decodeSourceRawEnvelope(result.sourceRaw);
  if (parts === null) {
    return panic(
      `${adapterKey}: publisher record has no retained raw envelope`,
    );
  }
  return parts;
};

type PublisherFieldCoverageOptions = {
  adapterKey: string;
  inventory: Pick<SourceFieldInventory, "fields">;
  observedFields: readonly string[];
  report: typeof logger.error;
};

/** Counts are additive per observed record; publisher values never enter logs. */
export const recordPublisherFieldCoverage = ({
  adapterKey,
  inventory,
  observedFields,
  report,
}: PublisherFieldCoverageOptions) => {
  const audit = publisherFieldRetentionAudit(inventory, observedFields);
  switch (audit.status) {
    case "unavailable":
      report(PUBLISHER_FIELD_COVERAGE_EVENT.READER_FAILED, {
        adapterKey,
        recordCount: 1,
        retainedRaw: true,
        readerFailure: audit.reason,
      });
      return audit;
    case "audited":
      if (audit.unmappedFields.length > 0) {
        report(PUBLISHER_FIELD_COVERAGE_EVENT.UNMAPPED, {
          adapterKey,
          recordCount: 1,
          unmappedFieldCount: audit.unmappedFields.length,
          retainedRaw: true,
        });
      }
      return audit;
    default:
      audit satisfies never;
      return panic("Unhandled publisher field retention observation");
  }
};

type InspectPublisherFieldCoverageOptions = RetainedPublisherPartsOptions & {
  inventory: SourceFieldInventory;
  report?: typeof logger.error;
};

/**
 * Observe the payload before any projection. Unknown fields stay in the same
 * envelope; a reader broken by publisher drift must not prevent its archive.
 */
export const inspectPublisherFieldCoverage = async ({
  adapterKey,
  inventory,
  result,
  report,
}: InspectPublisherFieldCoverageOptions): Promise<void> => {
  const parts = retainedPublisherParts({ adapterKey, result });
  const observed = await Result.tryPromise({
    try: async () => await inventory.listSourceFields(parts),
    catch: (cause) => cause,
  });
  if (Result.isError(observed)) {
    const emit =
      report ?? (await import("@/api/lib/observability/logger")).logger.error;
    emit(PUBLISHER_FIELD_COVERAGE_EVENT.READER_FAILED, {
      adapterKey,
      recordCount: 1,
      retainedRaw: true,
      readerFailure: errorTag(observed.error),
    });
    return;
  }
  const audit = publisherFieldRetentionAudit(inventory, observed.value);
  switch (audit.status) {
    case "unavailable":
      break;
    case "audited":
      if (audit.unmappedFields.length === 0) {
        return;
      }
      break;
    default:
      audit satisfies never;
      return panic("Unhandled publisher field retention observation");
  }
  const emit =
    report ?? (await import("@/api/lib/observability/logger")).logger.error;
  recordPublisherFieldCoverage({
    adapterKey,
    inventory,
    observedFields: observed.value,
    report: emit,
  });
};
