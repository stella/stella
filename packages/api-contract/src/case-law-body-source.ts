import * as v from "valibot";

import { API_STORABLE_INSTANT_CHECK } from "./api-date";
import { caseLawBodySourceSchemasOf } from "./case-law-body-source-shape";

export {
  COLLECTION_BODY_EXTENT,
  COLLECTION_CONTEXT_REPRESENTATION,
  COLLECTION_PROVENANCE_COVERAGE,
  COLLECTION_PUBLICATION_CONTRIBUTION,
  COLLECTION_PUBLICATION_PROJECTION_MAX,
  collectionBodyProvenanceSchemaOf,
  collectionContextLayoutSchema,
  DECISION_BODY_TEXT_SOURCE,
  decisionBodyAllowsDerivedAi,
  withoutCollectionLinks,
} from "./case-law-body-source-shape";
export type {
  CollectionContextLayout,
  CollectionPublicationProvenance,
  DecisionBodySource,
  LinklessDecisionBodySource,
} from "./case-law-body-source-shape";

/** The API contract checks each retrieval time is a storable instant. */
export const {
  collectionPublicationSchema,
  collectionBodyProvenanceSchema,
  decisionBodySourceSchema,
  linklessDecisionBodySourceSchema,
} = caseLawBodySourceSchemasOf(
  v.nullable(
    v.pipe(
      v.string(),
      v.isoTimestamp(),
      API_STORABLE_INSTANT_CHECK,
      v.maxLength(32),
    ),
  ),
);
