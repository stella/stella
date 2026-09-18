import * as v from "valibot";

/**
 * The wire contract the OpenAI-compatible `search`/`fetch` pair answers with,
 * shared by the two surfaces that serve the pair: the default audience, which
 * reads matters and the public legal corpus, and the law audience, which reads
 * the corpus alone.
 *
 * `metadata` is a discriminated union on `kind` rather than one open object.
 * Only a matter document belongs to a workspace, so only that branch carries
 * `workspaceId`; a strict object with an optional `workspaceId` would let a
 * corpus read answer with a tenant field and a model ask why it is missing.
 */
const fetchMetadataCommonEntries = {
  charCount: v.number(),
  source: v.literal("stella"),
  truncated: v.boolean(),
};

const DOCUMENT_FETCH_METADATA = v.strictObject({
  kind: v.literal("document"),
  ...fetchMetadataCommonEntries,
  anonymized: v.optional(v.literal(true)),
  anonymizedEntityCount: v.optional(v.number()),
  workspaceId: v.string(),
});

const DECISION_FETCH_METADATA = v.strictObject({
  kind: v.literal("decision"),
  ...fetchMetadataCommonEntries,
});

const STATUTE_FETCH_METADATA = v.strictObject({
  kind: v.literal("statute"),
  ...fetchMetadataCommonEntries,
});

const compatFetchOutput = <const TMetadata extends v.GenericSchema>(
  metadata: TMetadata,
) =>
  v.strictObject({
    id: v.string(),
    title: v.string(),
    text: v.string(),
    url: v.string(),
    nextCursor: v.nullable(v.string()),
    metadata,
  });

export const COMPAT_SEARCH_OUTPUT_SCHEMA = v.strictObject({
  results: v.array(
    v.strictObject({ id: v.string(), title: v.string(), url: v.string() }),
  ),
  nextCursor: v.optional(v.nullable(v.string())),
});

export const COMPAT_FETCH_OUTPUT_SCHEMA = compatFetchOutput(
  v.variant("kind", [
    DOCUMENT_FETCH_METADATA,
    DECISION_FETCH_METADATA,
    STATUTE_FETCH_METADATA,
  ]),
);

/**
 * The law audience's half: no matter data is reachable there, so `document` is
 * not a `kind` its `fetch` can answer with and the contract does not advertise
 * one.
 */
export const LAW_COMPAT_FETCH_OUTPUT_SCHEMA = compatFetchOutput(
  v.variant("kind", [DECISION_FETCH_METADATA, STATUTE_FETCH_METADATA]),
);
