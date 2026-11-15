import { classifyFailure } from "@stll/errors";

import type { ArtefactProvenanceDecodeError } from "@/api/lib/chat/artefact-provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { observedStatus } from "@/api/lib/observability/server-error-answer";

const SEARCH_PROVENANCE_UNREADABLE = failureSink({
  event: "search.provenance_unreadable",
  expected: [],
});

const SEARCH_PROVENANCE_UNREADABLE_MESSAGE = "Search results could not be read";

export const searchProvenanceError = (cause: ArtefactProvenanceDecodeError) => {
  observeFailure(cause, { sink: SEARCH_PROVENANCE_UNREADABLE });
  return classifyFailure(
    new HandlerError({
      status: 500,
      message: SEARCH_PROVENANCE_UNREADABLE_MESSAGE,
      cause,
    }),
    "tagged_failure",
  );
};

/** The handler answer for search results whose stored provenance is unreadable. */
export const searchProvenanceAnswer = (cause: ArtefactProvenanceDecodeError) =>
  observedStatus({ sink: SEARCH_PROVENANCE_UNREADABLE, cause }, 500, {
    message: SEARCH_PROVENANCE_UNREADABLE_MESSAGE,
  });
