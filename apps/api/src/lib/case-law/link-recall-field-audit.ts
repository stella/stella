import { panic } from "better-result";

import type { SourceFieldInventory } from "@/api/lib/legal-search/ingestion-types";
import { publisherFieldRetentionAudit } from "@/api/lib/legal-search/source-exclusion-census";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

type AuditRetainedPublisherFieldsOptions = {
  inventory: SourceFieldInventory;
  sourceRaw: string | null;
};

/** A legacy or absent response cannot prove which publisher fields were kept. */
export const auditRetainedPublisherFields = async ({
  inventory,
  sourceRaw,
}: AuditRetainedPublisherFieldsOptions) => {
  if (sourceRaw === null) {
    return { status: "unavailable", reason: "missing-raw" } as const;
  }
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return { status: "unavailable", reason: "legacy-raw" } as const;
  }
  const observedFields = [...new Set(await inventory.listSourceFields(parts))];
  const audit = publisherFieldRetentionAudit(inventory, observedFields);
  switch (audit.status) {
    case "unavailable":
      return audit;
    case "audited":
      return { ...audit, observedFields };
    default:
      audit satisfies never;
      return panic("Unhandled publisher field audit outcome");
  }
};
