import type { LegalDraft, LegalDraftDiagnostic } from "./types";

export const validateLegalDraft = (
  draft: LegalDraft,
): LegalDraftDiagnostic[] => {
  const diagnostics: LegalDraftDiagnostic[] = [];

  if (!draft.meta.title?.trim()) {
    diagnostics.push({
      code: "missing-title",
      message: "The draft must have a title.",
      severity: "error",
    });
  }

  let hasTopLevelClause = false;
  for (const block of draft.blocks) {
    if (block.type === "clause") {
      if (block.level === 1) {
        hasTopLevelClause = true;
      }
      if (block.level > 1 && !hasTopLevelClause) {
        diagnostics.push({
          code: "subclause-before-clause",
          message:
            "A subclause cannot appear before the first top-level clause.",
          severity: "error",
        });
      }
      if (!block.heading.trim()) {
        diagnostics.push({
          code: "empty-clause-heading",
          message: "Clause headings cannot be empty.",
          severity: "error",
        });
      }
    }

    if (block.type === "table") {
      if (block.table.headers.length === 0) {
        diagnostics.push({
          code: "empty-table",
          message: "Tables must include at least one header.",
          severity: "error",
        });
      }
      for (const row of block.table.rows) {
        if (row.length !== block.table.headers.length) {
          diagnostics.push({
            code: "ragged-table",
            message: "Every table row must match the header width.",
            severity: "error",
          });
        }
      }
    }

    if (block.type === "signatures" && block.parties.length === 0) {
      diagnostics.push({
        code: "empty-signatures",
        message: "The signatures block must include at least one party.",
        severity: "warning",
      });
    }
  }

  return diagnostics;
};
