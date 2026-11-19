import * as v from "valibot";

import {
  collectionBodyProvenanceSchemaOf,
  collectionPublicationSchema,
  decisionBodySourceSchema,
} from "@stll/api-contract/case-law-body-source";

import {
  CHAT_PROJECTION_METADATA_KEY,
  projectionBranch,
} from "./projection-fields";

const [hostBody, collectionBody] =
  decisionBodySourceSchema.options satisfies readonly [
    v.GenericSchema,
    v.GenericSchema,
  ];

const [completePublication, sectionPublication, unclassifiedPublication] =
  collectionPublicationSchema.options satisfies readonly [
    v.GenericSchema,
    v.GenericSchema,
    v.GenericSchema,
  ];

const projectedSource = v.strictObject({
  ...collectionBody.entries.source.entries,
  id: v.pipe(
    collectionBody.entries.source.entries.id,
    v.metadata({
      [CHAT_PROJECTION_METADATA_KEY]: { role: "passthroughId" },
    }),
  ),
});
const publicationFields = {
  source: projectedSource,
  sourceDocumentId: v.pipe(
    completePublication.entries.sourceDocumentId,
    v.metadata({
      [CHAT_PROJECTION_METADATA_KEY]: { role: "passthroughId" },
    }),
  ),
  sourceUrl: v.pipe(
    completePublication.entries.sourceUrl,
    v.metadata({
      [CHAT_PROJECTION_METADATA_KEY]: { role: "publicUrl" },
    }),
  ),
};
const publicationProjection = v.variant("extent", [
  projectionBranch(
    v.strictObject({ ...completePublication.entries, ...publicationFields }),
  ),
  projectionBranch(
    v.strictObject({ ...sectionPublication.entries, ...publicationFields }),
  ),
  projectionBranch(
    v.strictObject({
      ...unclassifiedPublication.entries,
      ...publicationFields,
    }),
  ),
]);
const provenance = collectionBodyProvenanceSchemaOf(publicationProjection);

/** Publication IDs and URLs stay public handles; the wire shape is canonical. */
export const decisionBodySourceProjection = v.variant("textSource", [
  projectionBranch(hostBody),
  projectionBranch(
    v.strictObject({
      ...collectionBody.entries,
      source: projectedSource,
      provenance: v.variant(
        "coverage",
        provenance.options.map(projectionBranch),
      ),
      sourceUrl: v.pipe(
        collectionBody.entries.sourceUrl,
        v.metadata({
          [CHAT_PROJECTION_METADATA_KEY]: { role: "publicUrl" },
        }),
      ),
    }),
  ),
]);
