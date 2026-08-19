import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import { StatuteText } from "@/features/statutes/components/statute-text";
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
  {
    type: "heading",
    id: "b-0",
    anchorId: "cast-prvni",
    level: 1,
    inlines: inlineText("Part One"),
    plainText: "Part One",
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

// The persisted shape legislation stores: a version and its blocks.
const ast = { version: 1, blocks };

describe("StatuteText", () => {
  test("every block carries its anchor id and the anchor scroll offset", () => {
    const markup = renderWithIntl(
      <StatuteText documentAst={ast} fulltext={null} language="cs" />,
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
      <StatuteText documentAst={ast} fulltext={null} language="cs" />,
    );

    expect(markup).toContain("<h1 class");
    expect(markup).toContain("<h4 class");
  });

  test("falls back to the plain text when the document has no parsed blocks", () => {
    const markup = renderWithIntl(
      <StatuteText
        documentAst={null}
        fulltext={"First paragraph.\n\nSecond paragraph."}
        language="cs"
      />,
    );

    expect(markup).toContain("First paragraph.");
    expect(markup).toContain("Second paragraph.");
  });

  test("says so when neither a parsed document nor plain text exists", () => {
    const markup = renderWithIntl(
      <StatuteText documentAst={null} fulltext={null} language="cs" />,
    );

    expect(markup).toContain(messages.statutes.emptyDocument);
  });
});
