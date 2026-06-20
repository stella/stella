import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Inline } from "@/api/handlers/case-law/document-ast";
import {
  inlinesToPlainText,
  stripInlinePrefix,
  walkInlines,
  type WalkInlinesOptions,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

const walk = (html: string, options?: WalkInlinesOptions): Inline[] => {
  const $ = cheerio.load(html);
  return walkInlines($, $("body"), options);
};

describe("walkInlines", () => {
  test("builds an inline tree from formatting tags", () => {
    const inlines = walk(
      "foo <b>bar</b> <i>baz</i><br><a href='https://x.test'>link</a>",
    );
    expect(inlines).toEqual([
      { type: "text", text: "foo " },
      { type: "bold", children: [{ type: "text", text: "bar" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "baz" }] },
      { type: "line-break" },
      {
        type: "link",
        href: "https://x.test",
        children: [{ type: "text", text: "link" }],
      },
    ]);
  });

  test("merges adjacent text separated by a skipped/empty node", () => {
    expect(walk("a<span></span>b")).toEqual([{ type: "text", text: "ab" }]);
  });

  test("unwraps presentational wrappers, keeping unwrapped siblings separate", () => {
    // Text spliced in via unwrap (push(...children)) is not coalesced at
    // the seam; only direct adjacent text children merge.
    expect(walk("<span>x</span><font>y</font>")).toEqual([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]);
  });

  test("sanitizeHref drops unsafe links to their text", () => {
    const options: WalkInlinesOptions = {
      sanitizeHref: (href) => (href.startsWith("https:") ? href : undefined),
    };
    expect(walk("<a href='javascript:alert(1)'>x</a>", options)).toEqual([
      { type: "text", text: "x" },
    ]);
    expect(walk("<a href='https://ok.test'>x</a>", options)).toEqual([
      {
        type: "link",
        href: "https://ok.test",
        children: [{ type: "text", text: "x" }],
      },
    ]);
  });

  test("parseImgAlt emits alt text only when enabled", () => {
    expect(walk("<img alt='Header'>", { parseImgAlt: true })).toEqual([
      { type: "text", text: "Header" },
    ]);
    expect(walk("<img alt='Header'>")).toEqual([]);
  });

  test("parseSpanStyle reads emphasis and skips empty spacer spans", () => {
    expect(
      walk("<span style='font-weight:bold'>x</span>", { parseSpanStyle: true }),
    ).toEqual([{ type: "bold", children: [{ type: "text", text: "x" }] }]);
    expect(
      walk("<span style='-aw-import:spaces'>   </span>", {
        parseSpanStyle: true,
      }),
    ).toEqual([]);
  });

  test("anonymization spans mark text and coalesce", () => {
    expect(walk("<span class='anon-block'>a<span></span>b</span>")).toEqual([
      { type: "text", text: "ab", anonymized: true },
    ]);
  });

  test("non-anonymized and anonymized text do not merge together", () => {
    const inlines = walk("plain<span class='anon-block'>secret</span>");
    expect(inlines).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: "secret", anonymized: true },
    ]);
  });
});

describe("stripInlinePrefix", () => {
  test("strips a leading prefix and trims the first text node", () => {
    const inlines: Inline[] = [{ type: "text", text: "1. Hello" }];
    expect(stripInlinePrefix(inlines, 3)).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });

  test("strips into a nested formatting node", () => {
    const inlines: Inline[] = [
      { type: "bold", children: [{ type: "text", text: "12" }] },
      { type: "text", text: "34" },
    ];
    expect(stripInlinePrefix(inlines, 1)).toEqual([
      { type: "bold", children: [{ type: "text", text: "2" }] },
      { type: "text", text: "34" },
    ]);
  });

  test("invariant: stripping N chars equals the plain text minus that prefix", () => {
    const inlines: Inline[] = [
      { type: "text", text: "Hello " },
      { type: "bold", children: [{ type: "text", text: "World" }] },
    ];
    const stripped = stripInlinePrefix(inlines, "Hello ".length);
    expect(inlinesToPlainText(stripped)).toBe("World");
  });
});
