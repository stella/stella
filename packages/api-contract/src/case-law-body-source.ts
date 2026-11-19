import { panic } from "better-result";
import * as v from "valibot";

export const DECISION_BODY_TEXT_SOURCE = {
  HOST: "host",
  COLLECTION: "collection",
} as const;

/** Publication provenance, distinct from the AST/fulltext passage format. */
export const decisionBodySourceSchema = v.variant("textSource", [
  v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.HOST),
  }),
  v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.COLLECTION),
    source: v.strictObject({
      id: v.pipe(v.string(), v.uuid(), v.maxLength(36)),
      name: v.pipe(v.string(), v.maxLength(1024)),
      adapterKey: v.pipe(v.string(), v.maxLength(256)),
      allowsDerivedAi: v.boolean(),
    }),
    sourceUrl: v.pipe(v.string(), v.url(), v.maxLength(8192)),
    retrievedAt: v.pipe(v.string(), v.isoTimestamp(), v.maxLength(32)),
  }),
]);

export type DecisionBodySource = v.InferOutput<typeof decisionBodySourceSchema>;

/** Host metadata rights never become broader when a collection supplies text. */
export const decisionBodyAllowsDerivedAi = ({
  source,
  bodySource,
}: {
  source: { allowsDerivedAi: boolean };
  bodySource: DecisionBodySource;
}): boolean => {
  switch (bodySource.textSource) {
    case DECISION_BODY_TEXT_SOURCE.HOST:
      return source.allowsDerivedAi;
    case DECISION_BODY_TEXT_SOURCE.COLLECTION:
      return source.allowsDerivedAi && bodySource.source.allowsDerivedAi;
    default:
      bodySource satisfies never;
      return panic("Unhandled decision body source");
  }
};
