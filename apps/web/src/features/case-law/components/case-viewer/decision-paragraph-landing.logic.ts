import { panic } from "better-result";

import { parseDecisionParagraphFragment } from "@stll/api-contract/decision-paragraph-range";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

export const decisionParagraphLanding = (
  ast: DocumentAst | null,
  fragment: string | undefined,
) => {
  if (
    fragment === undefined ||
    !fragment.replace(/^#/u, "").startsWith("par=")
  ) {
    return { type: "anchor", anchorId: fragment } as const;
  }
  const range = parseDecisionParagraphFragment(fragment);
  if (range === null) {
    return { type: "invalid" } as const;
  }
  if (ast === null) {
    return { type: "text-unavailable" } as const;
  }
  const resolution = resolveDecisionParagraphRange(ast, range);
  switch (resolution.type) {
    case "found":
      return {
        type: "range",
        range,
        anchorIds: resolution.anchorIds,
        firstAnchorId: resolution.firstAnchorId,
      } as const;
    case "not-found":
      return { type: "not-found", range } as const;
    default:
      resolution satisfies never;
      return panic("Unhandled decision paragraph range resolution");
  }
};
