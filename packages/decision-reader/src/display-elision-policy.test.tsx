import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import { renderReaderFixture as renderToStaticMarkup } from "./decision-text.test";
import { LiteralTextProvider } from "./display-elision-policy";
import { BlockRenderer, inlinesToPlainText } from "./document-ast-text";

const SPACED_LETTERS = "The choices are A B C D.";

const paragraph = (text: string): Block => {
  const inlines: Inline[] = [{ text, type: "text" }];
  return {
    anchorId: "par_1",
    id: "b1",
    inlines,
    plainText: inlinesToPlainText(inlines),
    type: "paragraph",
  };
};

const renderedText = (markup: string) =>
  markup.replaceAll(/<[^>]*>/gu, "").replaceAll("&nbsp;", " ");

const renderBlock = (text: string) => (
  <BlockRenderer
    activeMatchIndex={-1}
    anchorPresentation="embedded"
    block={paragraph(text)}
    rangesByPieceId={{}}
    variant="case-law"
  />
);

describe("display elision policy", () => {
  test("a court document reads with the publisher's spaced letters joined", () => {
    expect(
      renderedText(renderToStaticMarkup(renderBlock(SPACED_LETTERS))),
    ).toBe("The choices are ABCD.");
  });

  test("literal text keeps every stored character", () => {
    expect(
      renderedText(
        renderToStaticMarkup(
          <LiteralTextProvider>
            {renderBlock(SPACED_LETTERS)}
          </LiteralTextProvider>,
        ),
      ),
    ).toBe(SPACED_LETTERS);
  });
});
