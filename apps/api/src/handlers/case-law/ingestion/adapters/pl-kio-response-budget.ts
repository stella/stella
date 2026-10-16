import { Buffer } from "node:buffer";

export const PL_KIO_HTML_BUDGET = {
  maxBytes: 2 * 1024 * 1024,
  maxMarkupTokens: 20_000,
} as const;

export const PL_KIO_DOCUMENT_REJECTION = {
  OVERSIZED: "oversized",
  MARKUP_BUDGET_EXCEEDED: "markup-budget-exceeded",
} as const;

/** Conservatively bounds element and attribute allocation before building a DOM. */
export const inspectPlKioHtmlBudget = (html: string) => {
  if (Buffer.byteLength(html, "utf-8") > PL_KIO_HTML_BUDGET.maxBytes) {
    return { type: PL_KIO_DOCUMENT_REJECTION.OVERSIZED } as const;
  }
  let tokens = 0;
  for (const character of html) {
    if (character !== "<" && character !== "=") {
      continue;
    }
    tokens += 1;
    if (tokens > PL_KIO_HTML_BUDGET.maxMarkupTokens) {
      return {
        type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
      } as const;
    }
  }
  return { type: "accepted" } as const;
};
