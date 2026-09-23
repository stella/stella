import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  HEADING_CLASS,
  InlineContent,
} from "@/components/legal-reader/document-ast-text";
import { SEARCH_MARK_CLASS_NAME } from "@/components/legal-reader/query-marks";
import { StatuteBlock } from "@/features/statutes/components/statute-text";
import { compareStatuteBlocks } from "@/features/statutes/statute-compare";
import { compareText, markSide } from "@/features/statutes/statute-diff-marks";
import type { StatuteCompareSide } from "@/features/statutes/statute-diff-marks";
import messages from "@/i18n/langs/en.json";

// The comparison sets each cell through the reader's own block renderer, so
// a compared statute reads the way the statute does: the same centred
// containers, the same designation row, the same indented letters. These
// render the cells the way the comparison does and hold them to the reader.

const renderWithIntl = (children: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </IntlProvider>,
  );

const renderSide = (side: StatuteCompareSide) =>
  renderWithIntl(
    <>
      {markSide(side).map(({ block, rangesByPieceId }) => (
        <StatuteBlock
          anchorPresentation="embedded"
          block={block}
          key={block.id}
          rangesByPieceId={rangesByPieceId}
        />
      ))}
    </>,
  );

const classOf = (markup: string, tag: string): string | undefined =>
  new RegExp(`<${tag}[^>]*class="([^"]*)"`, "u").exec(markup)?.at(1);

/** The text a reader sees inside each `<ins>` or `<del>`, labels left out. */
const markedText = async (
  html: string,
  tag: "ins" | "del",
): Promise<string> => {
  let text = "";
  let depth = 0;
  let labelDepth = 0;
  await new HTMLRewriter()
    .on(tag, {
      element(element) {
        depth += 1;
        element.onEndTag(() => {
          depth -= 1;
        });
      },
    })
    .on("span.sr-only", {
      element(element) {
        labelDepth += 1;
        element.onEndTag(() => {
          labelDepth -= 1;
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (depth > 0 && labelDepth === 0) {
          text += chunk.text;
        }
      },
    })
    .transform(new Response(html))
    .text();
  return text;
};

const provisionHeading = (title: string): Block => ({
  type: "heading",
  id: `h-${title}`,
  anchorId: "par_2",
  level: 6,
  inlines: [
    { type: "text", text: "§ 2" },
    { type: "line-break" },
    { type: "text", text: title },
  ],
  plainText: `§ 2\n${title}`,
});

const letter = (value: string): Block => ({
  type: "paragraph",
  id: `p-${value}`,
  anchorId: "par_2-odst_1-pism_a",
  listDepth: 1,
  inlines: [{ type: "text", text: value }],
  plainText: value,
});

describe("compared blocks render as the reader renders them", () => {
  const older = [
    provisionHeading("Price of goods"),
    letter("a) the agreed price,"),
  ];
  const newer = [
    provisionHeading("Price of sold goods"),
    letter("a) the agreed purchase price,"),
  ];
  const compared = compareStatuteBlocks({ newer, older });
  if (compared.isErr()) {
    throw compared.error;
  }
  const [headingRow, letterRow] = compared.value;

  test("a compared heading carries the reader's heading classes", () => {
    const reader = renderWithIntl(
      <StatuteBlock
        anchorPresentation="document"
        block={newer[0] ?? provisionHeading("")}
        rangesByPieceId={{}}
      />,
    );
    const cell = renderSide(headingRow?.after ?? { blocks: [], segments: [] });

    expect(classOf(cell, "h6")).toBe(classOf(reader, "h6"));
    expect(classOf(cell, "h6")).toContain(HEADING_CLASS.statute[6]);
    // The designation sits on a row of its own, at the reader's size.
    expect(cell).toContain("text-[calc(1.35rem*var(--reader-text-scale))]");
    // An embedded cell repeats none of the document's ids.
    expect(cell).not.toContain('id="par_2"');
  });

  test("the diff is marked inside the reader's block", async () => {
    const before = renderSide(
      headingRow?.before ?? { blocks: [], segments: [] },
    );
    const after = renderSide(headingRow?.after ?? { blocks: [], segments: [] });

    expect(await markedText(after, "ins")).toBe("sold");
    expect(after).not.toContain("<del");
    expect(before).not.toContain("<ins");
    expect(after).toContain(messages.statutes.diffInserted);
  });

  test("a letter keeps the reader's list indent", async () => {
    const cell = renderSide(letterRow?.after ?? { blocks: [], segments: [] });

    expect(classOf(cell, "p")).toContain("ms-4");
    expect(await markedText(cell, "ins")).toBe("purchase");
  });
});

const paragraph: Block = {
  type: "paragraph",
  id: "p-1",
  anchorId: "par_1-odst_1",
  number: 12,
  inlines: [
    { type: "text", text: "(1) The " },
    { type: "bold", children: [{ type: "text", text: "seller" }] },
    { type: "line-break" },
    { type: "text", text: "delivers." },
  ],
  plainText: "(1) The seller\ndelivers.",
};

const table: Block = {
  type: "table",
  id: "t-1",
  anchorId: "priloha_1",
  rows: [
    [
      {
        inlines: [{ type: "text", text: "Rate" }],
        plainText: "Rate",
        header: true,
      },
      {
        inlines: [{ type: "text", text: "Amount" }],
        plainText: "Amount",
        header: true,
      },
    ],
    [
      { inlines: [{ type: "text", text: "Basic" }], plainText: "Basic" },
      { inlines: [{ type: "text", text: "15 %" }], plainText: "15 %" },
    ],
  ],
  plainText: "Rate Amount Basic 15 %",
};

describe("every block kind lines its marks up with its text", () => {
  // A side marked whole must render every character it shows inside a mark,
  // in order: a single character of drift between the compared text and the
  // renderer's offsets would leave one out or mark one twice.
  for (const block of [provisionHeading("Price"), paragraph, table]) {
    test(`${block.type} marked whole`, async () => {
      const whole = compareText([block]);
      const side = {
        blocks: [block],
        segments: [{ type: "del" as const, text: whole }],
      };
      const html = renderSide(side);
      const rangeCount = markSide(side)
        .flatMap(({ rangesByPieceId }) => Object.values(rangesByPieceId))
        .flat().length;

      // The renderer may set a piece out of order (a paragraph's number
      // hangs before its text), so the characters are compared as a set.
      const sorted = (value: string) => value.split("").toSorted().join("");
      expect(sorted(await markedText(html, "del"))).toBe(
        sorted(whole.replaceAll("\n", "")),
      );
      // Cut by inline boundaries into several marks, each range is still
      // announced once.
      expect(html.split(messages.statutes.diffRemoved).length - 1).toBe(
        rangeCount,
      );
    });
  }
});

describe("reader marks", () => {
  test("search, insertion and deletion each wear their own mark", () => {
    const html = renderWithIntl(
      <InlineContent
        activeMatchIndex={0}
        inlines={[{ type: "text", text: "old new found" }]}
        pieceId="p"
        ranges={[
          { type: "deleted", start: 0, end: 3 },
          { type: "inserted", start: 4, end: 7 },
          { type: "search", matchIndex: 0, start: 8, end: 13 },
        ]}
      />,
    );

    expect(html).toContain(
      `<span class="sr-only select-none" data-reader-chrome="">${messages.statutes.diffRemoved} </span>old</del>`,
    );
    expect(html).toContain(
      `<span class="sr-only select-none" data-reader-chrome="">${messages.statutes.diffInserted} </span>new</ins>`,
    );
    expect(html).toContain(
      `<mark class="${SEARCH_MARK_CLASS_NAME} ring-warning ring-1" data-reader-match-index="0">found</mark>`,
    );
  });
});
