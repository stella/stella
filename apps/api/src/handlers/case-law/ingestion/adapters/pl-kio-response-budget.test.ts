import { expect, test } from "bun:test";
import fc from "fast-check";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { load } from "@stll/html";
import { assertProperty } from "@stll/property-testing";

import { hasPlKioAttributeBudget } from "./pl-kio-attribute-budget";
import {
  PL_KIO_DOCUMENT_REJECTION,
  PL_KIO_HTML_BUDGET,
  readPlKioHtml,
} from "./pl-kio-response-budget";

const TEST_BYTE_CAP = 2 * 1024 * 1024;
const readTestHtml = (html: string) =>
  readPlKioHtml(html, { maxBytes: TEST_BYTE_CAP });

test("the HTML byte budget counts UTF-8 bytes rather than characters", () => {
  const atBudget = "ą".repeat(TEST_BYTE_CAP / 2);
  expect(readTestHtml(atBudget).type).toBe("accepted");
  expect(readTestHtml(`${atBudget}ą`)).toEqual({
    type: PL_KIO_DOCUMENT_REJECTION.OVERSIZED,
  });
});

test.each(["<b></b>", '<div a="b"></div>'])(
  "markup allocation is bounded independently of bytes for %s",
  (markup) => {
    const input = markup.repeat(PL_KIO_HTML_BUDGET.maxDomAllocations + 1);
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(
      TEST_BYTE_CAP,
    );
    expect(readTestHtml(input)).toEqual({
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
      TEST_BYTE_CAP,
    );
    expect(input.split("<").length - 1).toBeLessThan(5);
    expect(readTestHtml(input)).toEqual({
      type: PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    });
  },
);

test.each([
  "<div ",
  "</div ",
  '<div quoted=">" ',
  "<!-- x=\" --><p a='x\" >' ",
  '<div a\u00a0b=" >" ',
  '<div a\u0000b=" >" ',
  '<script><p a=" >" ',
  '<div a="&quot; >" ',
  "<div a='\\' ",
  "<div / ",
  '<div a=""b="" ',
])(
  "attribute prescan cannot hide a real tag after malformed or quoted prefix (%#)",
  (prefix) => {
    const names = Array.from(
      { length: PL_KIO_HTML_BUDGET.maxAttributesPerTag + 1 },
      (_, index) => `a${index}`,
    ).join(" ");
    const html = `${prefix}${names}>`;
    expect(hasPlKioAttributeBudget(html, PL_KIO_HTML_BUDGET)).toBe(false);
    expect(readTestHtml(html).type).toBe(
      PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
    );
  },
);

test("overlapping tag candidates exhaust linear work before parsing", () => {
  const html = `<div a="${"<p ".repeat(20_000)}">`;
  expect(hasPlKioAttributeBudget(html, PL_KIO_HTML_BUDGET)).toBe(false);
  expect(readTestHtml(html).type).toBe(
    PL_KIO_DOCUMENT_REJECTION.MARKUP_BUDGET_EXCEEDED,
  );
});

test("work on a loaded document after its parse is not charged to the publisher's budget", async () => {
  // A 27-page ruling converted from print: its markup builds 8,049 of the
  // 10,000 allocations, and AST validation then parses one fragment per
  // `<br>` it replaces with a space, 1,286 of them.
  const html = new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL("__fixtures__/pl-kio-content-420.html.gz", import.meta.url),
        ).arrayBuffer(),
      ),
    ),
  );
  const read = readTestHtml(html);
  if (read.type !== "accepted") {
    throw new TypeError(`Expected the ruling's markup to fit: ${read.type}`);
  }
  const $ = read.document;
  expect($("br").length).toBeGreaterThan(1000);
  $("br").replaceWith(" ");
  expect($("br").length).toBe(0);
});

test("duplicate names count before the parser can discard them", () => {
  const html = `<div ${"a ".repeat(PL_KIO_HTML_BUDGET.maxAttributesPerTag + 1)}>`;
  expect(hasPlKioAttributeBudget(html, PL_KIO_HTML_BUDGET)).toBe(false);
});

test("pl-kio.attribute-prescan-upper-bound: accepted scans bound parse5 across malformed HTML", () => {
  const fragments = fc.array(
    fc.constantFrom(
      "<p",
      "</p",
      "<svg",
      "<!--",
      "-->",
      " a",
      " b",
      " c",
      " d",
      " e",
      " f",
      "=",
      "'",
      '"',
      "/",
      ">",
      "<",
      " ",
      "\t",
      "\n",
      "\f",
      "\r",
      "\u00a0",
      "\u0000",
      "x",
      "&quot;",
    ),
    { maxLength: 120 },
  );
  const limits = { ...PL_KIO_HTML_BUDGET, maxAttributesPerTag: 2 };
  assertProperty(
    "pl-kio.attribute-prescan-upper-bound: accepted scans bound parse5 across malformed HTML",
    fc.property(fragments, (parts) => {
      const html = parts.join("");
      if (!hasPlKioAttributeBudget(html, limits)) {
        return;
      }
      load(html, {
        treeAdapter: {
          ...adapter,
          createElement: (...args) => {
            expect(args[2].length).toBeLessThanOrEqual(
              limits.maxAttributesPerTag,
            );
            return adapter.createElement(...args);
          },
        },
      });
    }),
  );
});
