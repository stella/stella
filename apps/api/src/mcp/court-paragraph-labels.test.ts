/**
 * What an agent reading a recorded decision sees of the court's paragraph
 * numbers: each paragraph's `position` (stella's count of the served
 * blocks), its `label`, its deep link and the decision's `numbering`.
 *
 * The court cites its own numbers, which run behind the position by however
 * many headings, ruling items and introductory blocks precede them, so the
 * label and the link must carry the court's number, never the position.
 */

import { describe, expect, test } from "bun:test";

import { decisionParagraphNumbering } from "@stll/legal-ast/court-paragraph-number";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { decisionBlockDeepLink } from "@/api/mcp/case-law-decision-link";
import { locateDecisionBlocks } from "@/api/mcp/case-law-decision-outline";
import { decisionParagraphs } from "@/api/mcp/case-law-decision-read";
import { toPlainCorpusText } from "@/api/mcp/tool-utils";
import {
  type EvidenceDocument,
  PROCESSED_FIELD_EVIDENCE_READERS,
} from "@/api/tests/helpers/processed-field-evidence";

const PARSERS = "src/handlers/case-law/ingestion/parsers/__fixtures__/";
const URL = "https://example.test/decision";

const only = async (
  documents: Promise<readonly EvidenceDocument[]>,
): Promise<DocumentAst> => {
  const [document, ...rest] = await documents;
  expect(rest).toEqual([]);
  if (document === undefined) {
    throw new Error("the recording holds no decision");
  }
  return document.ast;
};

/** The paragraphs a query answer is cut from, as the read tool builds them. */
const served = (ast: DocumentAst) => {
  const text = toPlainCorpusText({ blocks: ast.blocks, fulltext: null });
  if (text === null) {
    throw new Error("the recording serves no text");
  }
  const located = locateDecisionBlocks(ast.blocks, text);
  return {
    numbering: decisionParagraphNumbering(located),
    paragraphs: decisionParagraphs({ located, text }).map(
      (paragraph, index) => ({
        position: index + 1,
        label: paragraph.label,
        url: decisionBlockDeepLink({ url: URL, ...paragraph }).url,
      }),
    ),
  };
};

const readNss = async (fixture: string) =>
  served(
    await only(
      PROCESSED_FIELD_EVIDENCE_READERS["cz-nss"](`${PARSERS}${fixture}`),
    ),
  );

describe("Nejvyšší správní soud", () => {
  // Positions and numbers read off the court's own PDFs of both judgments.
  test.each([
    ["cz-nss-6-ads-21-2026.html.gz", 38, 27],
    ["cz-nss-10-as-245-2016.html.gz", 40, 29],
  ] as const)(
    "%s labels and links the court's [N], not the position",
    async (fixture, position, number) => {
      const { numbering, paragraphs } = await readNss(fixture);
      expect(numbering).toBe("court");
      const window = paragraphs.slice(position - 1, position + 2);
      expect(window).toEqual(
        [0, 1, 2].map((step) => ({
          position: position + step,
          label: String(number + step),
          url: `${URL}#par=${String(number + step)}`,
        })),
      );
      // The court's numbering runs whole from [1], each number once.
      const labels = paragraphs.flatMap(({ label }) =>
        label === null ? [] : [Number(label)],
      );
      expect(labels).toEqual(
        Array.from({ length: labels.length }, (_, index) => index + 1),
      );
    },
  );

  test("an older judgment that prints no numbers reads as numbering none", async () => {
    const { numbering, paragraphs } = await readNss(
      "cz-nss-5-as-1-2011.html.gz",
    );
    expect(numbering).toBe("none");
    expect(paragraphs.length).toBeGreaterThan(50);
    expect(paragraphs.filter(({ url }) => url?.includes("#par="))).toEqual([]);
  });
});

describe("Court of Justice", () => {
  test("labels and links the point numbers the publisher marks", async () => {
    const ast = await only(
      PROCESSED_FIELD_EVIDENCE_READERS["eu-ecj"](
        `${PARSERS}eu-ecj/62022CJ0128.en.html.gz`,
      ),
    );
    const { numbering, paragraphs } = served(ast);
    expect(numbering).toBe("court");
    const numbered = paragraphs.filter(({ url }) => url?.includes("#par="));
    expect(numbered.length).toBeGreaterThan(10);
    for (const { label, url } of numbered) {
      expect(url).toBe(`${URL}#par=${String(label)}`);
    }
    // Points sit behind the position: the title and the parties come first.
    const first = numbered.at(0);
    expect(first?.label).toBe("1");
    expect(first?.position).toBeGreaterThan(1);
  });
});
