import * as v from "valibot";

import { decisionParagraphRangeSchema } from "@stll/api-contract/decision-paragraph-range";
import { blockSchema } from "@stll/legal-ast/document-ast";

import { LIMITS } from "@/api/lib/limits";

import { cursorInput, nullAsAbsent, uuidInputSchema } from "./tool-utils";

export const READER_PAGE_MAX_CHARS = LIMITS.decisionReaderPageMaxChars;
export const READER_PAGE_CONTENT_CHARS = LIMITS.decisionReaderPageContentChars;
export const READER_FRAGMENT_CHARS =
  Math.floor(READER_PAGE_CONTENT_CHARS / 2) - 1024;
export const READER_OPEN_TEXT_CHARS = LIMITS.decisionReaderOpenTextChars;
export const READER_OUTLINE_ENTRIES = LIMITS.decisionReaderOutlineEntries;
export type ReaderWithheldTextPolicy = "metadata-only" | "show-to-user";
export const READER_WITHHELD_TEXT_POLICY: ReaderWithheldTextPolicy =
  "metadata-only";

export const openDecisionArgs = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema(
      "Decision ID returned by search_case_law or lookup_case_law.",
    ),
    paragraphs: v.optional(
      v.pipe(
        decisionParagraphRangeSchema,
        v.description(
          "Court paragraph number or inclusive range (48 or 48-53); hyphen or en dash, at most 500 court numbers. Never a block position.",
        ),
      ),
    ),
  }),
);
export const readDecisionBlocksArgs = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema(
      "Decision ID returned by open_case_law_decision.",
    ),
    cursor: cursorInput({
      description:
        "Pass nextCursor exactly; omit for the first page. Continue until null, including anchor-only pages.",
    }),
  }),
);
export const previewProvisionArgs = nullAsAbsent(
  v.strictObject({
    provision: v.strictObject({
      document_id: uuidInputSchema(
        "The consolidated legislation document ID supplied by a provision anchor.",
      ),
      anchor: v.pipe(
        v.string(),
        v.minLength(LIMITS.decisionReaderProvisionAnchorMinChars),
        v.maxLength(LIMITS.decisionReaderProvisionAnchorMaxChars),
      ),
      cited_anchor: v.optional(
        v.pipe(
          v.string(),
          v.minLength(LIMITS.decisionReaderProvisionAnchorMinChars),
          v.maxLength(LIMITS.decisionReaderProvisionAnchorMaxChars),
        ),
      ),
    }),
  }),
);

export const readerMetadataSchema = v.strictObject({
  decisionId: v.string(),
  caseNumber: v.string(),
  court: v.string(),
  country: v.string(),
  date: v.nullable(v.string()),
  ecli: v.nullable(v.string()),
  appUrl: v.nullable(v.string()),
});
export const withheldReasonSchema = v.strictObject({
  code: v.literal("source_licence"),
  message: v.string(),
});
export const readerOutlineSchema = v.strictObject({
  anchorId: v.string(),
  title: v.string(),
  level: v.number(),
});
export const readerWindowSchema = v.strictObject({
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
export const citationAnchorSchema = v.strictObject({
  pieceId: v.string(),
  start: v.number(),
  end: v.number(),
  citationId: v.string(),
  decisionId: v.string(),
});
export const provisionAnchorSchema = v.strictObject({
  pieceId: v.string(),
  start: v.number(),
  end: v.number(),
  provision: previewProvisionArgs.advertisedSchema.entries.provision,
});
export const blockFragmentSchema = v.strictObject({
  blockId: v.string(),
  offset: v.number(),
  totalChars: v.number(),
  json: v.string(),
});
export const blocksDecisionOutput = v.variant("status", [
  v.strictObject({
    status: v.literal("available"),
    metadata: readerMetadataSchema,
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
    metadata: readerMetadataSchema,
    withheldReason: withheldReasonSchema,
  }),
  v.strictObject({
    status: v.literal("unavailable"),
    metadata: readerMetadataSchema,
  }),
]);
const previewHeading = v.strictObject({
  anchorId: v.string(),
  level: v.number(),
  text: v.string(),
});
export const provisionPreviewOutput = v.strictObject({
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
