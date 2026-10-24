import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { BlockRenderer } from "./document-ast-text";
import { ReaderPresentationProvider } from "./reader-adapters";
import type { ReaderPresentationAdapters } from "./reader-adapters";

const messages = {
  "statutes.diffRemoved": "Removed",
  "statutes.diffInserted": "Inserted",
  "common.copyLink": "Copy link",
  "common.copied": "Copied",
  "common.back": "Back",
  "caseLaw.viewer.legalSentence": "Legal sentence",
  "caseLaw.viewer.abstract": "Abstract",
  "folio.comment": "Comment",
  "legalReader.annotations.highlight": "Highlight",
  "caseLaw.reader.headMatter": "Head matter",
  "caseLaw.notesFilter.ai": "AI",
  "common.court": "Court",
  "statutes.wordingVersionUnknown": "Wording version unknown",
  "statutes.openProvision": "Open provision",
  "statutes.provisionTextUnavailable": "Text not available",
  "statutes.showCitedPartOnly": "Show cited part only",
  "statutes.showFullProvision": "Show full provision",
  "aiDisclosure.caseLaw": "Generated disclosure",
  "aiDisclosure.billingDrafts": "Generated billing disclosure",
  sourceAttribution: (
    source: string,
    link: (children: ReactNode) => ReactNode,
  ): ReactNode => link(source),
  dissentByline: (names: readonly string[]) => names.join(", "),
  provisionPartTextUnavailable: (label: string) => `${label} unavailable`,
  provisionEffectiveFrom: (date: string) => date,
  formatValidityDate: (date: string | null) => date,
  provisionActText: ({ statuteTitle }: { statuteTitle: string }) =>
    statuteTitle,
  formatLabelList: (labels: readonly string[]) => labels.join(", "),
} satisfies ReaderPresentationAdapters["messages"];

const renderBlocks = (blocks: readonly Block[]): string =>
  renderToStaticMarkup(
    <ReaderPresentationProvider adapters={{ messages }}>
      {blocks.map((block) => (
        <BlockRenderer
          activeMatchIndex={-1}
          block={block}
          key={block.id}
          rangesByPieceId={{}}
          variant="case-law"
        />
      ))}
    </ReaderPresentationProvider>,
  );

const paragraph = (
  id: string,
  text: string,
  extra: Partial<ParagraphBlock> = {},
): ParagraphBlock => ({
  anchorId: id,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
  ...extra,
});

test("empty sections retain their addressable structure", () => {
  const markup = renderBlocks([
    {
      anchorId: "empty-heading",
      id: "empty-heading",
      inlines: [],
      level: 2,
      plainText: "",
      type: "heading",
    },
    paragraph("empty-paragraph", ""),
    {
      anchorId: "empty-table",
      id: "empty-table",
      plainText: "",
      rows: [],
      type: "table",
    },
  ]);

  expect(markup).toContain('<h2 class="group relative');
  expect(markup).toContain('id="empty-heading"');
  expect(markup).toContain('id="empty-paragraph"');
  expect(markup).toContain('id="empty-table"');
  expect(markup).toContain("<tbody></tbody>");
});

test("all supported list depths render without flattening their anchors", () => {
  const blocks = ([1, 2, 3, 4] as const).map((depth) =>
    paragraph(`depth-${String(depth)}`, `(${String(depth)}) item`, {
      listDepth: depth,
    }),
  );
  const markup = renderBlocks(blocks);

  for (const depth of [1, 2, 3, 4]) {
    expect(markup).toContain(`id="depth-${String(depth)}"`);
    expect(markup).toContain(`(${String(depth)}) item`);
  }
  for (const [depth, indent] of [
    [1, "ms-4 sm:ms-8"],
    [2, "ms-8 sm:ms-16"],
    [3, "ms-12 sm:ms-24"],
    [4, "ms-16 sm:ms-32"],
  ] as const) {
    expect(markup).toMatch(
      new RegExp(
        `<p class="[^"]*${indent}[^"]*"[^>]*id="depth-${String(depth)}"`,
        "u",
      ),
    );
  }
});

test("a footnote reference to a missing anchor stays a static in-document link", () => {
  const markup = renderBlocks([
    {
      anchorId: "reference",
      id: "reference",
      inlines: [
        { text: "Text", type: "text" },
        {
          children: [{ text: "9", type: "text" }],
          href: "#missing-note",
          type: "link",
        },
      ],
      plainText: "Text9",
      type: "paragraph",
    },
  ]);

  expect(markup).toContain('aria-label="missing-note"');
  expect(markup).toContain('href="#missing-note"');
  expect(markup).toContain(">9</a>");
});

test("anonymized names and mixed-direction text preserve the source wording", () => {
  const markup = renderBlocks([
    {
      anchorId: "parties",
      id: "parties",
      inlines: [
        { anonymized: true, text: "J. N.", type: "text" },
        { text: " ضد ACME בע״מ", type: "text" },
      ],
      plainText: "J. N. ضد ACME בע״מ",
      role: "parties",
      type: "paragraph",
    },
  ]);

  expect(markup).toContain(">[J. N.]</span>");
  expect(markup).toContain(" ضد ACME בע״מ");
});

test("tables retain headers, spans, cell anchors, and inline formatting", () => {
  const markup = renderBlocks([
    {
      anchorId: "orders",
      id: "orders",
      plainText: "OrderGranted\nCosts€10",
      rows: [
        [
          {
            colSpan: 2,
            header: true,
            inlines: [{ text: "Order", type: "text" }],
            plainText: "Order",
          },
          {
            inlines: [
              { children: [{ text: "Granted", type: "text" }], type: "bold" },
            ],
            plainText: "Granted",
            rowSpan: 2,
          },
        ],
        [
          {
            inlines: [{ text: "Costs", type: "text" }],
            plainText: "Costs",
          },
          {
            inlines: [
              { children: [{ text: "€10", type: "text" }], type: "italic" },
            ],
            plainText: "€10",
          },
        ],
      ],
      type: "table",
    },
  ]);

  expect(markup).toContain('<th class="border-border/55');
  expect(markup).toContain('colSpan="2"');
  expect(markup).toContain('rowSpan="2"');
  expect(markup).toContain('data-anchor="table:orders:0:0"');
  expect(markup).toContain("<strong");
  expect(markup).toContain("<em");
});

test("paragraph rendering preserves arbitrary long Unicode wording", () => {
  const character = fc.constantFrom("a", "Z", " ", "ž", "界", "ا", "א", "😀");
  assertProperty(
    "paragraph rendering preserves arbitrary long Unicode wording",
    fc.property(
      fc.array(character, { minLength: 256, maxLength: 4096 }),
      (characters) => {
        const text = characters.join("");
        const markup = renderBlocks([paragraph("long", text)]);
        const renderedText = markup.replaceAll(/<[^>]*>|<!-- -->/gu, "");
        expect(renderedText).toBe(text);
      },
    ),
    { numRuns: 40 },
  );
});
