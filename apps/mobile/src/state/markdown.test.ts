import { describe, expect, test } from "bun:test";

import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";

import { parseInline, parseMarkdown, plainText } from "./markdown";
import type { Block, Span } from "./markdown";

const SCHEME = MOBILE_REDIRECT_SCHEMES.production;
const CONTEXT = { appScheme: SCHEME };

describe("inline spans", () => {
  test("reads bold, italic, code and links", () => {
    expect(
      parseInline(
        "See **§ 2** of *the act*, `code` and [the ruling](https://x.test/r).",
        CONTEXT,
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
    expect(parseInline("2 * 3 * 4 and **open", CONTEXT)).toEqual([
      { text: "2 * 3 * 4 and **open" },
    ]);
    expect(parseInline("a snake_case_name here", CONTEXT)).toEqual([
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
        parseInline(`Call [the court](https://x.test) now`, CONTEXT),
      ).toHaveLength(3);
      expect(parseInline(`Call [the court](${href}) now`, CONTEXT)).toEqual([
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
    const links = parseMarkdown(markdown, CONTEXT)
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
    expect(
      parseInline(`[t](${SCHEME}:/timers)`, { appScheme: undefined }),
    ).toEqual([{ text: "t" }]);
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
        CONTEXT,
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
    expect(parseMarkdown("```\nline", CONTEXT)).toEqual([
      { type: "code", text: "line" },
    ]);
  });
});

const spansOf = (block: Block): Span[] => {
  switch (block.type) {
    case "code":
      return [];
    case "list":
      return block.items.flat();
    case "table":
      return [...block.header.flat(), ...block.rows.flat().flat()];
    case "heading":
    case "paragraph":
    case "quote":
      return block.spans;
  }
};

const MATTER = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const ENTITY = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6e";
const OTHER_ENTITY = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6f";
const DECISION = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c70";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("mentions and citations", () => {
  // A sent message as the server stores it: each chip the person picked is a
  // link to the item, its name escaped the way the stored markdown escapes it.
  const SENT = `Draft a new agreement from [loan\\_terms (v2)\\_draft.docx](#stella-entity=${MATTER}:${ENTITY}) and [Template \\[2024\\].pdf](#stella-entity=${MATTER}:${OTHER_ENTITY})`;

  test("read as chips named as the person saw them, never as the stored link", () => {
    expect(parseInline(SENT, CONTEXT)).toEqual([
      { text: "Draft a new agreement from " },
      {
        text: "loan_terms (v2)_draft",
        reference: {
          kind: "entity",
          label: "loan_terms (v2)_draft",
          name: "loan_terms (v2)_draft",
          matterId: MATTER,
          entityId: ENTITY,
          mimeType: DOCX,
        },
      },
      { text: " and " },
      {
        text: "Template [2024]",
        reference: {
          kind: "entity",
          label: "Template [2024]",
          name: "Template [2024]",
          matterId: MATTER,
          entityId: OTHER_ENTITY,
          mimeType: "application/pdf",
        },
      },
    ]);
  });

  test("name matters and decisions, and a mention without a matter lives in the thread's", () => {
    expect(
      parseInline(
        `[Smith v Jones](#stella-workspace=${MATTER}), [Pl. ÚS 1/23](#stella-decision=${DECISION}) and [the lease](#stella-entity=${ENTITY})`,
        { appScheme: SCHEME, matterId: MATTER },
      ).filter((span) => span.reference !== undefined),
    ).toEqual([
      {
        text: "Smith v Jones",
        reference: { kind: "matter", label: "Smith v Jones", matterId: MATTER },
      },
      {
        text: "Pl. ÚS 1/23",
        reference: {
          kind: "decision",
          label: "Pl. ÚS 1/23",
          decisionId: DECISION,
        },
      },
      {
        text: "the lease",
        reference: {
          kind: "entity",
          label: "the lease",
          name: "the lease",
          matterId: MATTER,
          entityId: ENTITY,
          mimeType: null,
        },
      },
    ]);
  });

  test("a reference the server could not stand behind reads as its words", () => {
    expect(
      parseInline("See [the draft](#stella-unresolved-ref) now", CONTEXT),
    ).toEqual([{ text: "See the draft now" }]);
  });

  test("an escaped mark is text, inside a span and out", () => {
    expect(parseInline("a \\*b\\* and **c\\_d**", CONTEXT)).toEqual([
      { text: "a *b* and " },
      { text: "c_d", bold: true },
    ]);
  });

  test("a link target may hold balanced parentheses, or anything in angle brackets", () => {
    expect(
      parseInline(
        "[a](https://x.test/b(2)) and [c](<https://x.test/d (3)>)",
        CONTEXT,
      ),
    ).toEqual([
      {
        text: "a",
        link: expect.objectContaining({ url: "https://x.test/b(2)" }),
      },
      // The space makes it a link the opener refuses, so it reads as text.
      { text: " and c" },
    ]);
  });
});

describe("tables and line breaks", () => {
  test("read a table's header and rows, each row as wide as the header", () => {
    const [table] = parseMarkdown(
      [
        "| Party | Role |",
        "| --- | :-: |",
        `| A \\| B | [the lease](#stella-entity=${MATTER}:${ENTITY}) |`,
        "| C |",
        "",
        "After.",
      ].join("\n"),
      CONTEXT,
    );
    expect(table).toEqual({
      type: "table",
      header: [[{ text: "Party" }], [{ text: "Role" }]],
      rows: [
        [
          [{ text: "A | B" }],
          [
            {
              text: "the lease",
              reference: {
                kind: "entity",
                label: "the lease",
                name: "the lease",
                matterId: MATTER,
                entityId: ENTITY,
                mimeType: null,
              },
            },
          ],
        ],
        [[{ text: "C" }], []],
      ],
    });
  });

  test("a line with a pipe but no delimiter row under it stays a paragraph", () => {
    expect(parseMarkdown("a | b\nc", CONTEXT)).toEqual([
      { type: "paragraph", spans: [{ text: "a | b c" }] },
    ]);
  });

  test("keeps a sent message's line breaks", () => {
    expect(parseMarkdown("Hi,  \nplease check\nthis.", CONTEXT)).toEqual([
      { type: "paragraph", spans: [{ text: "Hi,\nplease check this." }] },
    ]);
  });
});

describe("plain text", () => {
  test("is what a person reads: names for references, no marks", () => {
    expect(
      plainText(
        `**Two** documents: [loan\\_terms.docx](#stella-entity=${MATTER}:${ENTITY}).\n\n- one\n- two`,
        CONTEXT,
      ),
    ).toBe("Two documents: loan_terms.\n\n- one\n- two");
  });
});
