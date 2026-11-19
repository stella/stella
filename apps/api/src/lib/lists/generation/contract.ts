// Who produced a list generation run, and the closed set of reasons a run
// stella produces can fail with. Shared by the schema and its writers.

/**
 * `external`: a client submits the candidates itself through the generation
 * candidates endpoint. `stella`: a stella worker reads the sources and writes
 * the candidates; no client may submit into such a run.
 */
export const LIST_GENERATION_PRODUCERS = ["external", "stella"] as const;
export type ListGenerationProducer = (typeof LIST_GENERATION_PRODUCERS)[number];

export const LIST_GENERATION_RUN_ERROR_CODES = [
  // A source version is gone or no longer carries a readable file.
  "source_unavailable",
  "unsupported_format",
  "no_text",
  "ai_unavailable",
  "extraction_failed",
  "enqueue_failed",
  "access_revoked",
  "run_limit_reached",
  "internal",
] as const;
export type ListGenerationRunErrorCode =
  (typeof LIST_GENERATION_RUN_ERROR_CODES)[number];
