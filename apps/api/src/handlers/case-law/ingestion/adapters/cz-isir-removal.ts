import { panic, Result } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { readPublisher } from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { REMOVAL_UNPROBEABLE_REASON } from "@/api/lib/legal-search/removal-reconciliation-state";

const DOCUMENT_ID = /^[0-9]{1,12}$/u;

/**
 * Whether the insolvency register still serves a stored decision's document.
 *
 * The register stops serving every document of a proceeding it struck off
 * (§ 425 insolvenčního zákona) and answers 404 for it, as for a document it
 * withdrew. A HEAD request asks that without downloading the document, at
 * the source's own gate.
 */
export const probeCzIsirRemoval = async (
  sourceDocumentId: string,
  signal: AbortSignal,
): Promise<Result<PublisherRemovalRead, AdapterFetchError>> => {
  if (!DOCUMENT_ID.test(sourceDocumentId)) {
    return Result.ok({
      type: "unprobeable",
      reason: REMOVAL_UNPROBEABLE_REASON.INVALID_IDENTITY,
    } as const);
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await readPublisher(
        `https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=${sourceDocumentId}`,
        {
          adapterKey: ADAPTER_KEYS.CZ_ISIR,
          fetchStage: "document",
          method: "HEAD",
          refusalScope: "document",
          redirect: "error",
          headers: { "User-Agent": INGESTION_USER_AGENT },
          signal,
          timeoutMs: 30_000,
        },
      ),
    catch: (cause) =>
      cause instanceof AdapterFetchError
        ? cause
        : new AdapterFetchError({
            message: "Publisher removal read failed",
            adapterKey: ADAPTER_KEYS.CZ_ISIR,
            cursor: null,
            cause,
          }),
  });
  if (Result.isError(outcome)) {
    return Result.err(outcome.error);
  }
  const read = outcome.value;
  switch (read.type) {
    case "present":
      await read.value.body?.cancel();
      return Result.ok({ type: "present", value: null } as const);
    case "absent":
      if (read.evidence === "stated-zero") {
        return panic("A document endpoint cannot establish a listing count");
      }
      return Result.ok({ type: "absent", evidence: read.evidence } as const);
    case "refused":
    case "unavailable":
      return Result.ok(read);
    default:
      read satisfies never;
      return panic("Unhandled removal probe outcome");
  }
};
