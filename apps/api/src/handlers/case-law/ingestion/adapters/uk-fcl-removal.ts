import { panic } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { readPublisher } from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";

/** Recheck the exact document endpoint through the source's existing request gate. */
export const probeUkFclRemoval = async (
  sourceDocumentId: string,
  signal: AbortSignal,
): Promise<PublisherRemovalRead> => {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(sourceDocumentId) ||
    sourceDocumentId.length > 256
  ) {
    return {
      type: "unavailable",
      cause: { kind: "thrown", error: "Invalid publisher identity" },
    };
  }
  const outcome = await readPublisher(
    `https://caselaw.nationalarchives.gov.uk/${sourceDocumentId}/data.xml`,
    {
      adapterKey: ADAPTER_KEYS.UK_FCL,
      fetchStage: "document",
      refusalScope: "document",
      // Retries resume from the durable sweep checkpoint, one request per observation.
      redirect: "error",
      headers: { "User-Agent": INGESTION_USER_AGENT },
      signal,
      timeoutMs: 30_000,
    },
  );
  switch (outcome.type) {
    case "present":
      await outcome.value.body?.cancel();
      return { type: "present", value: null };
    case "absent":
      if (outcome.evidence === "stated-zero") {
        return panic("A document endpoint cannot establish a listing count");
      }
      return { type: "absent", evidence: outcome.evidence };
    case "refused":
    case "unavailable":
      return outcome;
    default:
      outcome satisfies never;
      return panic("Unhandled removal probe outcome");
  }
};
