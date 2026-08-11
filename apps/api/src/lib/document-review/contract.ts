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
