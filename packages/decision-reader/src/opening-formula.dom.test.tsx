import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  CZ_CAPTION_FORMS,
  detectDecisionCaption,
} from "@stll/legal-ast/decision-caption";
import type { Block } from "@stll/legal-ast/document-ast";

import { renderReaderFixture } from "./decision-text.test";
import {
  BlockRenderer,
  DecisionCaptionHeader,
  READER_PROSE_CLASS,
} from "./document-ast-text";
import { outlineFromHeadings } from "./reader-outline";

const FORMULA = "JMÉNEM REPUBLIKY";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A Czech decision's head as the parsers store it. */
const blocks: Block[] = [
  {
    type: "heading",
    id: "title",
    anchorId: "h-title",
    level: 1,
    role: "decision-title",
    inlines: text("ROZSUDEK"),
    plainText: "ROZSUDEK",
  },
  {
    type: "paragraph",
    id: "formula",
    anchorId: "p-formula",
    role: "opening-formula",
    inlines: text(FORMULA),
    plainText: FORMULA,
  },
  {
    type: "paragraph",
    id: "recital",
    anchorId: "p-recital",
    role: "intro",
    inlines: text("Nejvyšší správní soud rozhodl v senátě takto:"),
    plainText: "Nejvyšší správní soud rozhodl v senátě takto:",
  },
  {
    type: "heading",
    id: "reasons",
    anchorId: "h-reasons",
    level: 2,
    role: "section-heading",
    inlines: text("Odůvodnění:"),
    plainText: "Odůvodnění:",
  },
];

/** The rendered markup, as a document a test can query. */
const parse = (markup: string): HTMLElement =>
  new DOMParser().parseFromString(markup, "text/html").body;

/** An element's words, without the reader's chrome (the permalink mark). */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const chrome of copy.querySelectorAll("[data-reader-chrome]")) {
    chrome.remove();
  }
  return (copy.textContent ?? "").trim();
};

/** The element that draws the formula's words. */
const formulaElement = (root: HTMLElement): Element =>
  [...root.querySelectorAll("p, h1, h2, h3, h4, h5, h6")].find(
    (element) => wordsOf(element) === FORMULA,
  ) ?? panic("The formula is not drawn");

const classesOf = (element: Element): string[] => element.className.split(" ");

describe("the opening formula in the reader", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
  });

  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("is drawn centred under the title, as neither a heading nor prose", () => {
    const root = parse(
      renderReaderFixture(
        <>
          {blocks.map((block) => (
            <BlockRenderer
              activeMatchIndex={-1}
              block={block}
              key={block.id}
              rangesByPieceId={{}}
              variant="case-law"
            />
          ))}
        </>,
      ),
    );
    const formula = formulaElement(root);
    const title = root.querySelector("h1") ?? panic("The title is not drawn");

    expect(formula.tagName).toBe("P");
    expect(classesOf(formula)).toContain("text-center");
    expect(classesOf(formula)).toContain("font-semibold");
    expect(classesOf(formula)).not.toContain(READER_PROSE_CLASS);
    expect(classesOf(formula)).not.toContain("font-bold");
    // Directly under the title, in document order.
    expect(title.compareDocumentPosition(formula)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The preamble after it stays the court's running text.
    const recital =
      [...root.querySelectorAll("p")].find((element) =>
        element.textContent?.includes("rozhodl v senátě"),
      ) ?? panic("The recital is not drawn");
    expect(classesOf(recital)).toContain(READER_PROSE_CLASS);
  });

  test("looks the same when the reader draws it out of a stored caption", () => {
    const caption =
      detectDecisionCaption(blocks, CZ_CAPTION_FORMS) ??
      panic("The title and the formula are a caption");
    const fromCaption = formulaElement(
      parse(
        renderReaderFixture(
          <DecisionCaptionHeader
            activeMatchIndex={-1}
            caption={caption}
            landingAnchorId={undefined}
            rangesByPieceId={{}}
          />,
        ),
      ),
    );
    const formulaBlock =
      blocks.find((block) => block.id === "formula") ??
      panic("Missing the formula block");
    const fromRole = formulaElement(
      parse(
        renderReaderFixture(
          <BlockRenderer
            activeMatchIndex={-1}
            block={formulaBlock}
            rangesByPieceId={{}}
            variant="case-law"
          />,
        ),
      ),
    );

    expect(fromCaption.tagName).toBe("P");
    for (const name of ["text-center", "font-semibold", "tracking-wider"]) {
      expect(classesOf(fromCaption)).toContain(name);
      expect(classesOf(fromRole)).toContain(name);
    }
  });

  test("is not listed in the contents", () => {
    const outline = outlineFromHeadings(blocks);

    expect(outline.map((item) => item.id)).toEqual(["h-title", "h-reasons"]);
    expect(outline.map((item) => item.label)).not.toContain(FORMULA);
  });
});
