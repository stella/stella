import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { CITATION_REVIEW_ORIGIN } from "@/api/handlers/case-law/polarity/consts";
import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";
import {
  aiReviewEntries,
  byCitationIdEntries,
  byCitationKeyEntries,
  humanReviewEntries,
  reviewRefSchema,
  storedTextSchema,
} from "@/api/scripts/apply-reviewed-citation-labels-plan";
import type { CitationLabelDomain } from "@/api/scripts/apply-reviewed-citation-labels-plan";

const doctrineEntries = {
  kind: v.literal("doctrine"),
  reviewRef: reviewRefSchema,
  passage: storedTextSchema(100_000),
};
const evidenceQuoteSchema = v.pipe(
  storedTextSchema(10_000),
  v.check(
    (quote) => quote.trim().length > 0,
    "evidenceQuote must contain court wording",
  ),
);
const substantiveEntries = {
  ...doctrineEntries,
  doctrinalTreatment: v.picklist(
    DOCTRINAL_TREATMENTS.filter((treatment) => treatment !== "not_stated"),
  ),
  evidenceQuote: evidenceQuoteSchema,
};
const notStatedEntries = {
  ...doctrineEntries,
  doctrinalTreatment: v.literal("not_stated"),
  evidenceQuote: v.optional(v.nullable(evidenceQuoteSchema), null),
};

/** A doctrinal reading names the court's words, never a paraphrase. */
export const reviewedCitationDoctrineEntrySchema = v.pipe(
  v.union([
    v.strictObject({
      ...byCitationKeyEntries,
      ...substantiveEntries,
      ...humanReviewEntries,
    }),
    v.strictObject({
      ...byCitationKeyEntries,
      ...substantiveEntries,
      ...aiReviewEntries,
    }),
    v.strictObject({
      ...byCitationIdEntries,
      ...substantiveEntries,
      ...humanReviewEntries,
    }),
    v.strictObject({
      ...byCitationIdEntries,
      ...substantiveEntries,
      ...aiReviewEntries,
    }),
    v.strictObject({
      ...byCitationKeyEntries,
      ...notStatedEntries,
      ...humanReviewEntries,
    }),
    v.strictObject({
      ...byCitationKeyEntries,
      ...notStatedEntries,
      ...aiReviewEntries,
    }),
    v.strictObject({
      ...byCitationIdEntries,
      ...notStatedEntries,
      ...humanReviewEntries,
    }),
    v.strictObject({
      ...byCitationIdEntries,
      ...notStatedEntries,
      ...aiReviewEntries,
    }),
  ]),
  v.check(
    ({ doctrinalTreatment, evidenceQuote, passage }) =>
      evidenceQuote === null
        ? doctrinalTreatment === "not_stated"
        : passage.includes(evidenceQuote),
    "distinguishes and limits require a verbatim evidenceQuote from passage",
  ),
  v.check(
    (entry) =>
      entry.origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW ||
      sha256Hex(entry.passage) === entry.evidenceSha256,
    "evidenceSha256 must be the SHA256 digest of passage",
  ),
);

export type ReviewedCitationDoctrineEntry = v.InferOutput<
  typeof reviewedCitationDoctrineEntrySchema
>;

export const DOCTRINE_LABEL_DOMAIN = {
  type: "doctrine",
  parse: (row: unknown) => {
    const parsed = v.safeParse(reviewedCitationDoctrineEntrySchema, row);
    return parsed.success ? parsed.output : null;
  },
} as const satisfies CitationLabelDomain;
