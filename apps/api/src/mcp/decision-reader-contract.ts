import * as v from "valibot";

import { decisionParagraphRangeSchema } from "@stll/api-contract/decision-paragraph-range";

import { LIMITS } from "@/api/lib/limits";

import { cursorInput, nullAsAbsent, uuidInputSchema } from "./tool-utils";

export { READER_PAGE_MAX_CHARS } from "@stll/api-contract/limits";
export {
  openDecisionOutput,
  blocksDecisionOutput,
  provisionPreviewOutput,
} from "../lib/chat/decision-reader-projections";
export const READER_PAGE_CONTENT_CHARS = LIMITS.decisionReaderPageContentChars;
export const READER_FRAGMENT_CHARS =
  Math.floor(READER_PAGE_CONTENT_CHARS / 2) - 1024;
export const READER_OPEN_TEXT_CHARS = LIMITS.decisionReaderOpenTextChars;
export const READER_OUTLINE_ENTRIES = LIMITS.decisionReaderOutlineEntries;

export const openDecisionArgs = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema(
      "Decision ID returned by search_case_law or lookup_case_law.",
    ),
    paragraphs: v.optional(
      decisionParagraphRangeSchema(
        "Court paragraph number or inclusive range (48 or 48-53); hyphen or en dash, at most 500 court numbers. Never a block position.",
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
      maxLength: LIMITS.decisionReaderCursorMaxChars,
    }),
  }),
);
export const previewProvisionArgs = nullAsAbsent(
  v.strictObject({
    provision: v.pipe(
      v.strictObject({
        document_id: uuidInputSchema(
          "The consolidated legislation document ID supplied by a provision anchor.",
        ),
        anchor: v.pipe(
          v.string(),
          v.minLength(LIMITS.decisionReaderProvisionAnchorMinChars),
          v.maxLength(LIMITS.decisionReaderProvisionAnchorMaxChars),
          v.description("Provision heading anchor supplied by the anchor."),
        ),
        cited_anchor: v.optional(
          v.pipe(
            v.string(),
            v.minLength(LIMITS.decisionReaderProvisionAnchorMinChars),
            v.maxLength(LIMITS.decisionReaderProvisionAnchorMaxChars),
            v.description(
              "Exact cited provision anchor supplied by the anchor, when it differs from anchor.",
            ),
          ),
        ),
      }),
      v.description(
        "The provision object from a decision provision anchor, passed unchanged.",
      ),
    ),
  }),
);
