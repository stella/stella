import { describe, expect, test } from "bun:test";

import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";

import { parseInline, parseMarkdown } from "./markdown";
import type { Block, Span } from "./markdown";

const SCHEME = MOBILE_REDIRECT_SCHEMES.production;

describe("inline spans", () => {
  test("reads bold, italic, code and links", () => {
    expect(
      parseInline(
        "See **§ 2** of *the act*, `code` and [the ruling](https://x.test/r).",
        SCHEME,
      ),
    ).toEqual([
      { text: "See " },
      { text: "§ 2", bold: true },
      { text: " of " },
      { text: "the act", italic: true },
      { text: ", " },
      { text: "code", code: true },
      { text: " and " },
      {
        text: "the ruling",
        link: expect.objectContaining({
          kind: "web",
          url: "https://x.test/r",
          host: "x.test",
        }),
      },
      { text: "." },
    ]);
  });

  test("keeps unmatched markers, arithmetic and snake_case as text", () => {
    expect(parseInline("2 * 3 * 4 and **open", SCHEME)).toEqual([
      { text: "2 * 3 * 4 and **open" },
    ]);
    expect(parseInline("a snake_case_name here", SCHEME)).toEqual([
      { text: "a snake_case_name here" },
    ]);
  });
});

describe("links", () => {
  // No `)` inside: a link's target ends at its first one.
  const REFUSED = [
    // oxlint-disable-next-line no-script-url -- a link the parser must refuse.
    "javascript:location='x'",
    "data:text/html,x",
    "tel:+420123456789",
    "sms:+420123456789",
    "mailto:office@example.com",
    "whatsapp://send?text=x",
    "//example.com",
    "/matters/1",
    `${MOBILE_REDIRECT_SCHEMES.preview}:/timers`,
  ];

  test.each(REFUSED)(
    "a link to %s reads as its words, joined to the text around it",
    (href) => {
      // The fixture must be a link the parser reads, so the refusal is what
      // turns it into text.
      expect(
        parseInline(`Call [the court](https://x.test) now`, SCHEME),
      ).toHaveLength(3);
      expect(parseInline(`Call [the court](${href}) now`, SCHEME)).toEqual([
        { text: "Call the court now" },
      ]);
    },
  );

  test("only accepted links become link spans, in every kind of block", () => {
    const hrefs = [
      ...REFUSED,
      "https://nalus.usoud.cz/x",
      "HTTP://usoud.cz",
      `${SCHEME}:/timers`,
    ];
    const markdown = hrefs
      .flatMap((href) => [
        `# [h](${href})`,
        `[p](${href})`,
        `- [l](${href})`,
        `> [q](${href})`,
        "",
      ])
      .join("\n");
    const links = parseMarkdown(markdown, SCHEME)
      .flatMap(spansOf)
      .filter((span) => span.link !== undefined)
      .map((span) => span.link?.url);
    expect(links).toEqual(
      [
        "https://nalus.usoud.cz/x",
        "http://usoud.cz",
        `${SCHEME}:/timers`,
      ].flatMap((url) => [url, url, url, url]),
    );
  });

  test("app links stay text where the caller names no scheme of its own", () => {
    expect(parseInline(`[t](${SCHEME}:/timers)`, undefined)).toEqual([
      { text: "t" },
    ]);
  });
});

describe("blocks", () => {
  test("reads headings, paragraphs, lists, quotes and fenced code", () => {
    expect(
      parseMarkdown(
        [
          "## Summary",
          "The court",
          "agreed.",
          "",
          "- first",
          "- second",
          "1. one",
          "> quoted",
          "```",
          "const x = 1;",
          "```",
        ].join("\n"),
        SCHEME,
      ),
    ).toEqual([
      { type: "heading", level: 2, spans: [{ text: "Summary" }] },
      { type: "paragraph", spans: [{ text: "The court agreed." }] },
      {
        type: "list",
        ordered: false,
        items: [[{ text: "first" }], [{ text: "second" }]],
      },
      { type: "list", ordered: true, items: [[{ text: "one" }]] },
      { type: "quote", spans: [{ text: "quoted" }] },
      { type: "code", text: "const x = 1;" },
    ]);
  });

  test("an unclosed fence takes the rest of the answer as code", () => {
    expect(parseMarkdown("```\nline", SCHEME)).toEqual([
      { type: "code", text: "line" },
    ]);
  });
});

const spansOf = (block: Block): Span[] => {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote": {
      return block.spans;
    }
    case "list": {
      return block.items.flat();
    }
    case "code": {
      return [];
    }
  }
};
