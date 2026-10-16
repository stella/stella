import { expect, test } from "bun:test";

import {
  readPlKioHtml,
  PL_KIO_DOCUMENT_REJECTION,
  PL_KIO_HTML_BUDGET,
} from "./pl-kio-response-budget";

test("the HTML byte budget counts UTF-8 bytes rather than characters", () => {
  const atBudget = "ą".repeat(PL_KIO_HTML_BUDGET.maxBytes / 2);
  expect(readPlKioHtml(atBudget).type).toBe("accepted");
  expect(readPlKioHtml(`${atBudget}ą`)).toEqual({
    type: PL_KIO_DOCUMENT_REJECTION.OVERSIZED,
  });
});

test.each(["<b></b>", '<div a="b"></div>'])(
  "markup allocation is bounded independently of bytes for %s",
  (markup) => {
    const input = markup.repeat(PL_KIO_HTML_BUDGET.maxDomAllocations + 1);
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(
      PL_KIO_HTML_BUDGET.maxBytes,
    );
    expect(readPlKioHtml(input)).toEqual({
      type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    });
  },
);

test.each([
  { prefix: "<div ", suffix: "></div>", separator: " " },
  { prefix: "<div ", suffix: "></div>", separator: "\t" },
  { prefix: "<div ", suffix: "></div>", separator: "\n" },
  { prefix: "<div ", suffix: "></div>", separator: "\r" },
  { prefix: "<div ", suffix: "></div>", separator: "\f" },
  { prefix: '<div quoted=">" ', suffix: "></div>", separator: " " },
  { prefix: '<!-- quoted=" --><div ', suffix: "></div>", separator: " " },
  { prefix: "<svg><path ", suffix: "/></svg>", separator: " " },
])(
  "distinct valueless attributes are counted in $prefix",
  ({ prefix, suffix, separator }) => {
    const attributes = Array.from(
      { length: PL_KIO_HTML_BUDGET.maxDomAllocations },
      (_, index) => `a${index}`,
    ).join(separator);
    const input = `${prefix}${attributes}${suffix}`;
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(
      PL_KIO_HTML_BUDGET.maxBytes,
    );
    expect(input.split("<").length - 1).toBeLessThan(5);
    expect(readPlKioHtml(input)).toEqual({
      type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    });
  },
);
