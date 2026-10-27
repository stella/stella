import { describe, expect, test } from "bun:test";

import { PARAGRAPH_ROLES } from "@stll/legal-ast/document-ast";
import type {
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { E_SBIRKA_ANCHORS } from "@stll/legal-ast/statute-anchor-scheme";

import { renderReaderFixture } from "./decision-text.test";
import {
  BlockRenderer,
  FulltextFallback,
  READER_PROSE_CLASS,
} from "./document-ast-text";

// Running text is start-aligned. Justified decision text stretches the word
// spaces of any line that holds a long unbreakable token (a case number, a
// file reference), and start, unlike left, follows the document's direction.

const READER_CSS = await Bun.file(
  new URL("reader.css", import.meta.url),
).text();

const CSS_WITHOUT_COMMENTS = READER_CSS.replaceAll(/\/\*[\s\S]*?\*\//gu, "");

/** Tailwind's alignment utilities, which a paragraph may state for itself. */
const ALIGNMENT_UTILITY = /^text-(?:start|end|left|right|center|justify)$/u;

const declarationsOf = (selector: string): string[] => {
  const rules = CSS_WITHOUT_COMMENTS.matchAll(
    /(?<selector>[^{}]+)\{(?<body>[^{}]*)\}/gu,
  );
  const matching = [...rules].filter(
    (rule) => rule.groups?.["selector"]?.trim() === selector,
  );
  return matching.flatMap((rule) =>
    (rule.groups?.["body"] ?? "")
      .split(";")
      .map((declaration) => declaration.trim().replaceAll(/\s+/gu, " "))
      .filter((declaration) => declaration !== ""),
  );
};

const paragraphClasses = (markup: string): string[][] =>
  [...markup.matchAll(/<p class="(?<classes>[^"]*)"/gu)].map((match) =>
    (match.groups?.["classes"] ?? "").split(" "),
  );

const paragraph = (role: ParagraphRole | undefined): ParagraphBlock => ({
  type: "paragraph",
  id: `p-${role ?? "body"}`,
  anchorId: `p-${role ?? "body"}`,
  role,
  inlines: [
    {
      type: "text",
      text: "Usnesením bylo porušeno právo stěžovatele na spravedlivý proces.",
    },
  ],
  plainText: "Usnesením bylo porušeno právo stěžovatele na spravedlivý proces.",
});

describe("running text alignment", () => {
  test("the prose class aligns to the start edge", () => {
    expect(declarationsOf(`.${READER_PROSE_CLASS}`)).toContain(
      "text-align: start",
    );
  });

  test("no reader rule justifies text", () => {
    expect(CSS_WITHOUT_COMMENTS).not.toMatch(
      /text-align(?:-last)?\s*:\s*justify/u,
    );
  });

  /** Each reader, with the anchor scheme a statute reader reads its paths by. */
  const READER_CORPORA = {
    "case-law": { variant: "case-law" },
    statute: { statuteAnchors: E_SBIRKA_ANCHORS, variant: "statute" },
  } as const;

  test("every paragraph takes its alignment from exactly one source", () => {
    // The prose class is unlayered CSS, so it would override a Tailwind
    // alignment utility on the same element rather than defer to it.
    const roles = [undefined, ...PARAGRAPH_ROLES];
    for (const corpus of Object.values(READER_CORPORA)) {
      const { variant } = corpus;
      for (const role of roles) {
        const markup = renderReaderFixture(
          <BlockRenderer
            activeMatchIndex={-1}
            block={paragraph(role)}
            rangesByPieceId={{}}
            {...corpus}
          />,
        );
        const [classes] = paragraphClasses(markup);
        const sources = (classes ?? []).filter(
          (name) => name === READER_PROSE_CLASS || ALIGNMENT_UTILITY.test(name),
        );
        expect({ role, variant, sources: sources.length }).toEqual({
          role,
          variant,
          sources: 1,
        });
        expect(classes).not.toContain("text-justify");
      }
    }
  });

  test("body paragraphs and stored full text are set as prose", () => {
    const body = renderReaderFixture(
      <BlockRenderer
        activeMatchIndex={-1}
        block={paragraph("holding")}
        rangesByPieceId={{}}
        variant="case-law"
      />,
    );
    const fulltext = renderReaderFixture(
      <FulltextFallback
        activeMatchIndex={-1}
        rangesByPieceId={{}}
        text={"I. Usnesením bylo porušeno právo.\n\nII. Ruší se."}
      />,
    );
    for (const classes of [
      ...paragraphClasses(body),
      ...paragraphClasses(fulltext),
    ]) {
      expect(classes).toContain(READER_PROSE_CLASS);
    }
    expect(paragraphClasses(fulltext)).toHaveLength(2);
  });
});
