import type { RichPatchValue } from "@/api/handlers/docx/types";

import type { ClauseBody } from "./types";

/**
 * Convert a ClauseBody into a RichPatchValue suitable for
 * DOCX template filling. Filters out block directives and
 * maps each paragraph to runs.
 */
export const clauseBodyToRichPatch = (body: ClauseBody): RichPatchValue => ({
  paragraphs: body
    .filter((p) => !p.isDirective)
    .map((p) => ({
      runs: p.runs ?? [{ text: p.text }],
    })),
});
