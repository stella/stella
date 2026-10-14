import { projectPlainText } from "@stll/legal-ast/document-ast";

import type { ValidationSourcePolicy } from "@/api/lib/legal-search/parsers/validate-ast";

import { markupResidueIn } from "./markup-residue";

// Project per source element / AST block before whitespace folding, so OCR
// letters on different lines cannot form invented words after a second pass.
export const courtListenerValidationPolicy = {
  source: "courtlistener",
  projectSourceText: (text) => projectPlainText([{ type: "text", text }]),
  projectInlineText: (inlines) =>
    projectPlainText(inlines).replace(/\s+/gu, " ").trim().toLowerCase(),
  markupResidueIn,
} satisfies ValidationSourcePolicy;
