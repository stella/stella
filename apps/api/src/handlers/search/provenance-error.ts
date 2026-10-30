import type { ArtefactProvenanceDecodeError } from "@/api/lib/ai-generation/provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const SEARCH_PROVENANCE_UNREADABLE = failureSink({
  event: "search.provenance_unreadable",
  expected: [],
});

export const searchProvenanceError = (cause: ArtefactProvenanceDecodeError) => {
  observeFailure(cause, { sink: SEARCH_PROVENANCE_UNREADABLE });
  return new HandlerError({
    status: 500,
    message: "Search results could not be read",
    cause,
  });
};
