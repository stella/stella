import { panic } from "better-result";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  readBodyText,
  readPublisher,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { REMOVAL_UNPROBEABLE_REASON } from "@/api/lib/legal-search/removal-reconciliation-state";

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
      type: "unprobeable",
      reason: REMOVAL_UNPROBEABLE_REASON.INVALID_IDENTITY,
    };
  }
  const outcome = await readPublisher(
    `https://caselaw.nationalarchives.gov.uk/${sourceDocumentId}/data.xml`,
    {
      adapterKey: ADAPTER_KEYS.UK_FCL,
      fetchStage: "document",
      refusalScope: "document",
      isRateLimitRedirect: (response) =>
        response.status >= 300 &&
        response.status < 400 &&
        (response.headers.has("Retry-After") ||
          /(?:rate[-_]?limit|too[-_]?many[-_]?requests|throttl)/iu.test(
            response.headers.get("location") ?? "",
          )),
      // Retries resume from the durable sweep checkpoint, one request per observation.
      redirect: "manual",
      headers: { "User-Agent": INGESTION_USER_AGENT },
      signal,
      timeoutMs: 30_000,
    },
  );
  switch (outcome.type) {
    case "present": {
      const headers = outcome.value.headers;
      const retryAfter = headers.get("Retry-After");
      if (
        retryAfter !== null ||
        headers.get("content-type")?.includes("text/html")
      ) {
        const body = await readBodyText(outcome, signal);
        if (body.type === "unavailable") {
          return body;
        }
        if (body.type !== "present") {
          return panic("A successful response body changed publisher outcome");
        }
        if (
          retryAfter !== null ||
          /(?:rate[ -]?limit|too many requests|request limit|throttl)/iu.test(
            body.value,
          )
        ) {
          throw new AdapterFetchError({
            message: "Publisher removal request paused",
            adapterKey: ADAPTER_KEYS.UK_FCL,
            cursor: null,
            stopKind: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
            ...(retryAfter === null ? {} : { retryAfter }),
          });
        }
        return {
          type: "unavailable",
          cause: { kind: "status", status: outcome.value.status },
        };
      }
      await outcome.value.body?.cancel();
      return { type: "present", value: null };
    }
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
