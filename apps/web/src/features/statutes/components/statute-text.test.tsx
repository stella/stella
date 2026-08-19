import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import { StatuteText } from "@/features/statutes/components/statute-text";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

// A statute is cited by provision, so `/law/<country>/statutes/<id>#<anchorId>`
// is the address of a paragraph. The link only resolves if the renderer puts
// that anchor on the element as an `id`, offset below the sticky top bar.

const renderWithIntl = (children: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </IntlProvider>,
  );

const inlineText = (text: string) => [{ type: "text" as const, text }];

const blocks = [
  // The publisher states a division's designation and its title as two
  // lines of one heading, joined by a line break.
  {
    type: "heading",
    id: "b-0",
    anchorId: "cast-prvni",
    level: 1,
    inlines: [
      { type: "text", text: "ČÁST PRVNÍ" },
      { type: "line-break" },
      { type: "text", text: "OBECNÁ ČÁST" },
    ],
    plainText: "ČÁST PRVNÍ\nOBECNÁ ČÁST",
  },
  {
    type: "heading",
    id: "b-1",
    anchorId: "hlava-i",
    level: 4,
    inlines: inlineText("Title I"),
    plainText: "Title I",
  },
  {
    type: "heading",
    id: "b-1a",
    anchorId: "zastoupeni",
    level: 5,
    inlines: inlineText("Representation by a household member"),
    plainText: "Representation by a household member",
  },
  {
    type: "heading",
    id: "b-1b",
    anchorId: "paragraf-47",
    level: 6,
    inlines: inlineText("§ 47"),
    plainText: "§ 47",
  },
  {
    type: "paragraph",
    id: "b-2",
    anchorId: "paragraf-1",
    inlines: inlineText("Everyone has the capacity to have rights."),
    plainText: "Everyone has the capacity to have rights.",
  },
  {
    type: "table",
    id: "b-3",
    anchorId: "priloha-1",
    rows: [
      [
        { inlines: inlineText("Rate"), plainText: "Rate" },
        { inlines: inlineText("21 %"), plainText: "21 %" },
      ],
    ],
    plainText: "Rate 21 %",
  },
] satisfies Block[];

describe("StatuteText", () => {
  test("every block carries its anchor id and the anchor scroll offset", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={blocks}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    for (const block of blocks) {
      expect(markup).toContain(`id="${block.anchorId}"`);
    }

    expect(
      markup.split("scroll-mt-[var(--reader-anchor-offset)]"),
    ).toHaveLength(blocks.length + 1);
  });

  test("heading depth reaches the DOM as the matching heading element", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={blocks}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    expect(markup).toContain("<h1 class");
    expect(markup).toContain("<h4 class");
  });

  test("a heading's two lines stay one block, split by a break", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={blocks}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    // One block, two lines: the designation and the title it names. Run
    // together on one line the title stops reading as what ČÁST PRVNÍ is,
    // so the break the parser states has to survive into the DOM.
    expect(markup).toContain("ČÁST PRVNÍ<br/>OBECNÁ ČÁST");
  });

  test("structural headings are centred", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={blocks}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    // A statute is read by its containers, and the publisher centres every
    // one of them — a section designation left-aligned at body size reads
    // as an aside rather than as the provision it opens.
    for (const tag of ["h1", "h4"]) {
      const opening = markup.slice(markup.indexOf(`<${tag} class="`));
      expect(opening.slice(0, opening.indexOf(">"))).toContain("text-center");
    }
  });

  test("every block offers exactly one permalink to its own anchor", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={blocks}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    // A statute is cited by provision, so every block is an address. One
    // link per block: two would make the same provision two targets.
    for (const block of blocks) {
      expect(markup.split(`href="#${block.anchorId}"`)).toHaveLength(2);
      expect(markup).toContain(`data-anchor="${block.anchorId}"`);
    }
  });

  test("falls back to the plain text when the document has no parsed blocks", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={[]}
        citationWork={null}
        fulltext={"First paragraph.\n\nSecond paragraph."}
        language="cs"
      />,
    );

    expect(markup).toContain("First paragraph.");
    expect(markup).toContain("Second paragraph.");
  });

  test("says so when neither a parsed document nor plain text exists", () => {
    const markup = renderWithIntl(
      <StatuteText
        blocks={[]}
        citationWork={null}
        fulltext={null}
        language="cs"
      />,
    );

    expect(markup).toContain(messages.statutes.emptyDocument);
  });

  test("offers incoming case law on the provisions, and only on those", () => {
    const queryClient = new QueryClient();
    const markup = renderWithIntl(
      <QueryClientProvider client={queryClient}>
        <FormattingProvider locale="en" timeZone="UTC">
          <StatuteText
            blocks={blocks}
            citationWork={{ eli: "/eli/cz/sb/2012/89", jurisdiction: "CZE" }}
            fulltext={null}
            language="cs"
          />
        </FormattingProvider>
      </QueryClientProvider>,
    );

    // The fixture states four headings and only one of them (`§ 47`) opens a
    // provision; a container heading is not a citable unit.
    expect(blocks.filter((block) => block.type === "heading")).toHaveLength(4);
    expect(markup.split(messages.caseLaw.viewer.citedBy)).toHaveLength(2);
  });

  test("asks for nothing until a reader opens a provision's case law", () => {
    const queryClient = new QueryClient();

    renderWithIntl(
      <QueryClientProvider client={queryClient}>
        <FormattingProvider locale="en" timeZone="UTC">
          <StatuteText
            blocks={blocks}
            citationWork={{ eli: "/eli/cz/sb/2012/89", jurisdiction: "CZE" }}
            fulltext={null}
            language="cs"
          />
        </FormattingProvider>
      </QueryClientProvider>,
    );

    // A consolidated code renders thousands of provisions: one read per
    // provision at mount would be one request per heading on the page.
    for (const query of queryClient.getQueryCache().getAll()) {
      expect(query.state.fetchStatus).toBe("idle");
    }
  });
});
