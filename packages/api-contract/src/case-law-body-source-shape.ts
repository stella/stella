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
const positiveInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

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

/**
 * A retrieval time as a bounded string, for browser-bundled readers whose
 * other dates are plain strings too. The API contract checks the instant.
 */
export const boundedRetrievedAtSchema = v.nullable(
  v.pipe(v.string(), v.maxLength(32)),
);

type RetrievedAtSchema = v.GenericSchema<string | null>;

/**
 * Every collection attribution schema from one retrieval-time schema, so the
 * API contract and the browser readers share one shape and differ only in
 * how strictly they check the instant.
 */
export const caseLawBodySourceSchemasOf = <
  const TRetrievedAt extends RetrievedAtSchema,
>(
  retrievedAt: TRetrievedAt,
) => {
  const publicationEntries = {
    source: sourceSchema,
    sourceDocumentId: v.nullable(v.pipe(v.string(), v.maxLength(256))),
    sourceUrl: sourceUrlSchema,
    retrievedAt,
    contribution: v.picklist(
      Object.values(COLLECTION_PUBLICATION_CONTRIBUTION),
    ),
  };
  const completePublication = v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.COMPLETE),
    ...publicationEntries,
  });
  const sectionPublication = v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.SECTION),
    sectionNumber: positiveInteger,
    collectionLabel: v.pipe(v.string(), v.maxLength(256)),
    contextLayout: v.optional(collectionContextLayoutSchema),
    ...publicationEntries,
  });
  const unclassifiedPublication = v.strictObject({
    extent: v.literal(COLLECTION_BODY_EXTENT.UNCLASSIFIED),
    ...publicationEntries,
  });
  /** Per-post attribution contains no body prose, headnotes or object-store locators. */
  const collectionPublicationSchema = v.variant("extent", [
    completePublication,
    sectionPublication,
    unclassifiedPublication,
  ]);
  const collectionBodyProvenanceSchema = collectionBodyProvenanceSchemaOf(
    collectionPublicationSchema,
  );
  const hostBodySource = v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.HOST),
  });
  const collectionBodySource = v.strictObject({
    textSource: v.literal(DECISION_BODY_TEXT_SOURCE.COLLECTION),
    source: sourceSchema,
    sourceUrl: sourceUrlSchema,
    retrievedAt,
    extent: v.picklist(Object.values(COLLECTION_BODY_EXTENT)),
    provenance: collectionBodyProvenanceSchema,
  });
  /** Publication provenance, distinct from the AST/fulltext passage format. */
  const decisionBodySourceSchema = v.variant("textSource", [
    hostBodySource,
    collectionBodySource,
  ]);
  /**
   * Collection attribution for outputs whose one publisher link is the
   * decision's own: the canonical shape without its publication URLs.
   */
  const linklessDecisionBodySourceSchema = v.variant("textSource", [
    hostBodySource,
    v.strictObject({
      ...v.omit(collectionBodySource, ["sourceUrl", "provenance"]).entries,
      provenance: collectionBodyProvenanceSchemaOf(
        v.variant("extent", [
          v.omit(completePublication, ["sourceUrl"]),
          v.omit(sectionPublication, ["sourceUrl"]),
          v.omit(unclassifiedPublication, ["sourceUrl"]),
        ]),
      ),
    }),
  ]);
  return {
    collectionPublicationSchema,
    collectionBodyProvenanceSchema,
    decisionBodySourceSchema,
    linklessDecisionBodySourceSchema,
  };
};

type CaseLawBodySourceSchemas = ReturnType<
  typeof caseLawBodySourceSchemasOf<typeof boundedRetrievedAtSchema>
>;

export type CollectionPublicationProvenance = v.InferOutput<
  CaseLawBodySourceSchemas["collectionPublicationSchema"]
>;
export type DecisionBodySource = v.InferOutput<
  CaseLawBodySourceSchemas["decisionBodySourceSchema"]
>;
export type LinklessDecisionBodySource = v.InferOutput<
  CaseLawBodySourceSchemas["linklessDecisionBodySourceSchema"]
>;

/** Drops every collection publication URL; the host branch has none. */
export const withoutCollectionLinks = (
  bodySource: DecisionBodySource,
): LinklessDecisionBodySource => {
  switch (bodySource.textSource) {
    case DECISION_BODY_TEXT_SOURCE.HOST:
      return bodySource;
    case DECISION_BODY_TEXT_SOURCE.COLLECTION: {
      const { sourceUrl: _sourceUrl, provenance, ...body } = bodySource;
      return {
        ...body,
        provenance: {
          ...provenance,
          records: provenance.records.map(
            ({ sourceUrl: _publicationUrl, ...record }) => record,
          ),
        },
      };
    }
    default:
      bodySource satisfies never;
      return panic("Unhandled decision body source");
  }
};

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
