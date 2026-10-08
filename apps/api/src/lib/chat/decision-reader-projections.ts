import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import {
  READER_PAGE_MAX_CHARS,
  READER_PROVISION_ANCHOR_MIN_CHARS,
  READER_PROVISION_ANCHOR_MAX_CHARS,
} from "@stll/api-contract/limits";
import { DECISION_PRIMARY_REFERENCE_TYPES } from "@stll/legal-ast/decision-identifier";
import { blockSchema } from "@stll/legal-ast/document-ast";

const readerMetadataSchema = v.strictObject({
  decisionId: v.string(),
  caseNumber: v.string(),
  caseNumberType: v.picklist(DECISION_PRIMARY_REFERENCE_TYPES),
  courtAbbreviation: v.nullable(v.string()),
  courtTier: v.picklist(COURT_TIER_LABELS),
  language: v.string(),
  court: v.string(),
  country: v.string(),
  date: v.nullable(v.string()),
  ecli: v.nullable(v.string()),
  appUrl: v.nullable(v.string()),
});
const withheldReasonSchema = v.strictObject({
  code: v.literal("source_licence"),
  message: v.string(),
});
const readerOutlineSchema = v.strictObject({
  anchorId: v.string(),
  title: v.string(),
  level: v.number(),
});
const readerWindowSchema = v.strictObject({
  anchorId: v.string(),
  number: v.nullable(v.number()),
  text: v.string(),
});
export const openDecisionOutput = v.variant("status", [
  v.strictObject({
    status: v.literal("available"),
    metadata: readerMetadataSchema,
    outline: v.array(readerOutlineSchema),
    window: v.array(readerWindowSchema),
    truncated: v.boolean(),
  }),
  v.strictObject({
    status: v.literal("withheld"),
    metadata: readerMetadataSchema,
    withheldReason: withheldReasonSchema,
  }),
  v.strictObject({
    status: v.literal("unavailable"),
    metadata: readerMetadataSchema,
  }),
]);
const citationAnchorSchema = v.strictObject({
  pieceId: v.string(),
  start: v.number(),
  end: v.number(),
  citationId: v.string(),
  decisionId: v.string(),
  appUrl: v.nullable(v.string()),
});
const provisionAnchorSchema = v.strictObject({
  appUrl: v.nullable(v.string()),
  pieceId: v.string(),
  start: v.number(),
  end: v.number(),
  provision: v.strictObject({
    document_id: v.pipe(v.string(), v.uuid()),
    anchor: v.pipe(
      v.string(),
      v.minLength(READER_PROVISION_ANCHOR_MIN_CHARS),
      v.maxLength(READER_PROVISION_ANCHOR_MAX_CHARS),
    ),
    cited_anchor: v.optional(
      v.pipe(
        v.string(),
        v.minLength(READER_PROVISION_ANCHOR_MIN_CHARS),
        v.maxLength(READER_PROVISION_ANCHOR_MAX_CHARS),
      ),
    ),
  }),
});
const blockFragmentSchema = v.strictObject({
  blockId: v.string(),
  offset: v.number(),
  totalChars: v.number(),
  json: v.string(),
});
// Metadata is shared by every outcome, so it is published once beside the
// outcome union rather than inside each branch.
export const blocksDecisionOutput = v.strictObject({
  metadata: readerMetadataSchema,
  content: v.variant("status", [
    v.strictObject({
      status: v.literal("available"),
      phase: v.picklist(["blocks", "citations", "provisions"]),
      items: v.array(blockSchema),
      blockFragments: v.array(blockFragmentSchema),
      citationAnchors: v.array(citationAnchorSchema),
      provisionAnchors: v.array(provisionAnchorSchema),
      nextCursor: v.nullable(v.string()),
      limit: v.literal(READER_PAGE_MAX_CHARS),
    }),
    v.strictObject({
      status: v.literal("withheld"),
      withheldReason: withheldReasonSchema,
    }),
    v.strictObject({ status: v.literal("unavailable") }),
  ]),
});
const previewHeading = v.strictObject({
  anchorId: v.string(),
  level: v.number(),
  text: v.string(),
});
export const provisionPreviewOutput = v.strictObject({
  appUrl: v.nullable(v.string()),
  documentId: v.string(),
  language: v.string(),
  anchorId: v.string(),
  citedAnchorId: v.nullable(v.string()),
  headings: v.array(previewHeading),
  heading: v.nullable(
    v.strictObject({ id: v.string(), ...previewHeading.entries }),
  ),
  blocks: v.array(
    v.strictObject({ id: v.string(), anchorId: v.string(), text: v.string() }),
  ),
});
