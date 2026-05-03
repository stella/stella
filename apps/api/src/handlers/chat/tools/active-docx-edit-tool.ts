import { valibotSchema } from "@ai-sdk/valibot";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import * as v from "valibot";

export const APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME = "apply-active-docx-edits";

const commentSchema = v.strictObject({
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(2000),
    v.description("Optional Word comment text to attach to this edit."),
  ),
});

const severitySchema = v.pipe(
  v.picklist(["low", "medium", "high"]),
  v.description(
    'Required. "low" for typos, spelling, minor style; "medium" for ' +
      'wording or terminology fixes; "high" for substantive changes ' +
      "(numbers, dates, parties, legal effect). The review panel " +
      "sorts by this — pick one.",
  ),
);

const areaSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.description(
    "Required. Short topic label that groups related operations: " +
      '"Spelling", "Names", "Penalty", "Arbitration", "Payment Terms", ' +
      '"Cross-references", "General". The review panel groups by this — ' +
      "use a consistent label across operations that belong together.",
  ),
);

const baseOperationSchema = {
  blockId: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(
      'Block id from the active DOCX editing snapshot, for example "b-0010".',
    ),
  ),
  severity: severitySchema,
  area: areaSchema,
} as const;

const operationSchema = v.variant("type", [
  v.strictObject({
    ...baseOperationSchema,
    type: v.literal("replaceInBlock"),
    find: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Exact text to replace inside the target block."),
    ),
    replace: v.pipe(v.string(), v.description("Replacement text.")),
    comment: v.optional(commentSchema),
  }),
  v.strictObject({
    ...baseOperationSchema,
    type: v.union([
      v.literal("insertAfterBlock"),
      v.literal("insertBeforeBlock"),
    ]),
    text: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Text for the inserted block."),
    ),
    inheritFormatting: v.optional(v.boolean()),
    comment: v.optional(commentSchema),
  }),
  v.strictObject({
    ...baseOperationSchema,
    type: v.literal("replaceBlock"),
    text: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Full replacement text for the target block."),
    ),
    preserveFormatting: v.optional(v.boolean()),
    comment: v.optional(commentSchema),
  }),
  v.strictObject({
    ...baseOperationSchema,
    type: v.literal("deleteBlock"),
    comment: v.optional(commentSchema),
  }),
  v.strictObject({
    ...baseOperationSchema,
    type: v.literal("commentOnBlock"),
    quote: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Optional exact quote inside the target block."),
      ),
    ),
    comment: commentSchema,
  }),
]);

const skippedOperationSchema = v.strictObject({
  id: v.string(),
  reason: v.picklist([
    "missingBlock",
    "changedBlock",
    "ambiguousFind",
    "missingFind",
    "unsupportedBlock",
    "emptyOperation",
    "documentNotEditable",
  ]),
});

const outputSchema = v.strictObject({
  applied: v.pipe(
    v.array(
      v.strictObject({
        id: v.string(),
        commentId: v.optional(v.number()),
      }),
    ),
    v.description(
      "Operations already written to the document by this tool call. " +
        "With the queued flow this list is normally empty; only claim a " +
        "change was made for ids that appear here.",
    ),
  ),
  queued: v.pipe(
    v.optional(
      v.array(
        v.strictObject({
          id: v.string(),
        }),
      ),
    ),
    v.description(
      "Operations now visible to the user as suggestions in the review " +
        "panel. NOT yet written to the document — the user reviews them " +
        "and applies each individually (or all at once). Tell the user " +
        "the suggestions are ready for review; do NOT claim the document " +
        "was changed. Do not retry these operations.",
    ),
  ),
  skipped: v.pipe(
    v.array(skippedOperationSchema),
    v.description(
      "Operations that could not be queued (e.g. no active file, " +
        "missing block). Tell the user plainly what is missing.",
    ),
  ),
});

export const createActiveDocxEditTool = () =>
  tool({
    description:
      "Propose edits for the DOCX currently open in the document " +
      "editor. Use this whenever the user asks to change, edit, " +
      "replace, rewrite, or 'propíš/uprav' text in the open DOCX, or " +
      "asks for a review/redline. Operations are queued for the user to " +
      "review and apply themselves; this tool does NOT write to the " +
      "document. See each schema field for its semantics.",
    needsApproval: true,
    inputSchema: valibotSchema(
      v.strictObject({
        operations: v.pipe(
          v.array(operationSchema),
          v.minLength(1),
          // Long contracts routinely produce 50+ legitimate ops in
          // one redline pass (verified in trace: a 40-op
          // cross-reference cleanup hit the old 20 cap and the
          // tool returned error-text — the model then claimed "40
          // ready" because it didn't read the validation failure).
          // The review panel sorts/groups large batches fine; the
          // ceiling here is just a sanity guard, not a UX limit.
          v.maxLength(200),
          v.description("Operations to apply to the active DOCX."),
        ),
      }),
    ),
    outputSchema: valibotSchema(outputSchema),
  });
