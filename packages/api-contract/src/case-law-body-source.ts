import { panic } from "better-result";
import * as v from "valibot";

export const DECISION_BODY_TEXT_SOURCE = {
  HOST: "host",
  COLLECTION: "collection",
} as const;

export const COLLECTION_BODY_EXTENT = {
  COMPLETE: "complete",
  SECTION: "section",
  UNCLASSIFIED: "unclassified",
} as const;

export const COLLECTION_PUBLICATION_CONTRIBUTION = {
  BODY: "body",
  RELATED: "related",
} as const;

export const COLLECTION_PROVENANCE_COVERAGE = {
  ALL: "all",
  TRUNCATED: "truncated",
} as const;

export const COLLECTION_PUBLICATION_PROJECTION_MAX = 32;

export const COLLECTION_CONTEXT_REPRESENTATION = {
  DISPLAYED: "displayed",
  ALTERNATE_WRAPPING: "alternate-wrapping",
} as const;

export const collectionContextLayoutSchema = v.strictObject({
  sha256: v.pipe(
    v.string(),
    v.minLength(64),
    v.maxLength(64),
    v.regex(/^[0-9a-f]{64}$/u),
  ),
  representation: v.picklist(Object.values(COLLECTION_CONTEXT_REPRESENTATION)),
});
export type CollectionContextLayout = v.InferOutput<
  typeof collectionContextLayoutSchema
>;

const sourceSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid(), v.maxLength(36)),
  name: v.pipe(v.string(), v.maxLength(1024)),
  adapterKey: v.pipe(v.string(), v.maxLength(256)),
  allowsDerivedAi: v.boolean(),
});
const sourceUrlSchema = v.pipe(v.string(), v.url(), v.maxLength(8192));
const retrievedAtSchema = v.nullable(
  v.pipe(v.string(), v.isoTimestamp(), v.maxLength(32)),
);
const positiveInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const publicationEntries = {
  source: sourceSchema,
  sourceDocumentId: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  sourceUrl: sourceUrlSchema,
  retrievedAt: retrievedAtSchema,
  contribution: v.picklist(Object.values(COLLECTION_PUBLICATION_CONTRIBUTION)),
};

/** Per-post attribution contains no body prose, headnotes or object-store locators. */
export const collectionPublicationSchema = v.variant("extent", [
  v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.COMPLETE),
    ...publicationEntries,
  }),
  v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.SECTION),
    sectionNumber: positiveInteger,
    collectionLabel: v.pipe(v.string(), v.maxLength(256)),
    contextLayout: v.optional(collectionContextLayoutSchema),
    ...publicationEntries,
  }),
  v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.UNCLASSIFIED),
    ...publicationEntries,
  }),
]);

/** The retained publication count remains visible when its projection is bounded. */
export const collectionBodyProvenanceSchemaOf = <
  const TPublication extends v.GenericSchema,
>(
  publication: TPublication,
) => {
  const records = v.pipe(
    v.array(publication),
    v.minLength(1),
    v.maxLength(COLLECTION_PUBLICATION_PROJECTION_MAX),
  );
  return v.variant("coverage", [
    v.strictObject({
      coverage: v.literal(COLLECTION_PROVENANCE_COVERAGE.ALL),
      totalCount: positiveInteger,
      omittedCount: v.literal(0),
      records,
    }),
    v.strictObject({
      coverage: v.literal(COLLECTION_PROVENANCE_COVERAGE.TRUNCATED),
      totalCount: positiveInteger,
      omittedCount: positiveInteger,
      records,
    }),
  ]);
};

export const collectionBodyProvenanceSchema = collectionBodyProvenanceSchemaOf(
  collectionPublicationSchema,
);

export type CollectionPublicationProvenance = v.InferOutput<
  typeof collectionPublicationSchema
>;

/** Publication provenance, distinct from the AST/fulltext passage format. */
export const decisionBodySourceSchema = v.variant("textSource", [
  v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.HOST),
  }),
  v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.COLLECTION),
    source: sourceSchema,
    sourceUrl: sourceUrlSchema,
    retrievedAt: retrievedAtSchema,
    extent: v.picklist(Object.values(COLLECTION_BODY_EXTENT)),
    provenance: collectionBodyProvenanceSchema,
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
      return (
        source.allowsDerivedAi &&
        bodySource.source.allowsDerivedAi &&
        bodySource.provenance.records.every(
          (publication) =>
            publication.contribution !==
              COLLECTION_PUBLICATION_CONTRIBUTION.BODY ||
            publication.source.allowsDerivedAi,
        )
      );
    default:
      bodySource satisfies never;
      return panic("Unhandled decision body source");
  }
};
