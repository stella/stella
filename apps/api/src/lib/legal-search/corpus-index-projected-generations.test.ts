import { expect, test } from "bun:test";

import { CorpusIndexGenerationUnknownError } from "@/api/lib/legal-search/corpus-index-projected-generations";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

const anySink = failureSink({
  event: "corpus_projection.generation_unknown.test",
  expected: [],
});

test("a writer refused for an unknown generation grades as transient, so its caller retries instead of rejecting the input", () => {
  // The case-law batch and the other ingestion loops hold a record for retry
  // only when its failure grades transient; any other grade records it as
  // rejected and moves past it.
  const refusal = new CorpusIndexGenerationUnknownError({
    message: "unknown generation",
    family: "case_law",
    unknown: [{ generation: "case_law_v99", status: "building" }],
  });

  expect(gradeFailure(readEvidence(refusal), anySink)).toMatchObject({
    reason: "corpus_generation_unknown",
    grade: "transient",
  });
});
