import { expect, test } from "bun:test";

import {
  inspectPlKioHtmlBudget,
  PL_KIO_DOCUMENT_REJECTION,
  PL_KIO_HTML_BUDGET,
} from "./pl-kio-response-budget";

test("the HTML byte budget counts UTF-8 bytes rather than characters", () => {
  const atBudget = "ą".repeat(PL_KIO_HTML_BUDGET.maxBytes / 2);
  expect(inspectPlKioHtmlBudget(atBudget)).toEqual({ type: "accepted" });
  expect(inspectPlKioHtmlBudget(`${atBudget}ą`)).toEqual({
    type: PL_KIO_DOCUMENT_REJECTION.OVERSIZED,
  });
});

test.each(["<b></b>", ' a="b"'])(
  "markup allocation is bounded independently of bytes for %s",
  (markup) => {
    const input = markup.repeat(PL_KIO_HTML_BUDGET.maxMarkupTokens + 1);
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(
      PL_KIO_HTML_BUDGET.maxBytes,
    );
    expect(inspectPlKioHtmlBudget(input)).toEqual({
      type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    });
  },
);
