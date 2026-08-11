// The review topic shape the document-review engine consumes. It is a plain
// type, not an Elysia schema: the engine runs from handlers today and from a
// background worker later, and lib may not import a handler slice. The wire
// schema in `handlers/document-reviews/schemas.ts` is bound to this type, so a
// request-shape change that stops matching the engine fails typecheck there.

type ReviewTopicBase = {
  topicId: string;
  title: string;
  context: string;
  included: boolean;
};

export type DocumentReviewTopic =
  | (ReviewTopicBase & { type: "playbook"; positionId: string })
  | (ReviewTopicBase & { type: "reference" })
  | (ReviewTopicBase & { type: "custom" });

// Reference-comparison outcome vocabulary. It lives here rather than in
// `reference-compare.ts` so the persisted-run schema can derive its CHECK
// constraint from the same const the model's output schema is built from,
// without the database module importing the AI stack.
export const REFERENCE_ASSESSMENTS = [
  "aligned",
  "different",
  "missing-from-target",
  "additional-in-target",
  "deal-specific",
  "not-comparable",
] as const;
export type ReferenceAssessment = (typeof REFERENCE_ASSESSMENTS)[number];

// How consistently the references agreed about a topic. `single` is the
// degenerate one-reference case, normalized after the model answers.
export const REFERENCE_CONSENSUS_VALUES = [
  "single",
  "consistent",
  "mixed",
] as const;
export type ReferenceConsensus = (typeof REFERENCE_CONSENSUS_VALUES)[number];
