/**
 * The UOKiK decision reader against decision PDFs the register served.
 *
 * The oracle is each file's own text layer: every word the PDF prints has to
 * reach the parsed document, measured by the same retention check the
 * pipeline logs, but against the extracted lines rather than against the
 * markup this reader builds from them.
 */

import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@/api/handlers/case-law/document-ast";
import {
  parsePlUokikDocument,
  plUokikDocumentLines,
} from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import type { ParsePlUokikDocumentInput } from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import {
  buildValidationHtml,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";

/** A 2011 decision whose embedded fonts name no weight. */
const DOK_9_2011 = new URL(
  "__fixtures__/pl-uokik-dok-9-2011.pdf",
  import.meta.url,
);

/** A 2024 decision with named bold faces and hanging-indent paragraphs. */
const RGD_16_2024 = new URL(
  "__fixtures__/pl-uokik-rgd-16-2024.pdf",
  import.meta.url,
);

const bytesOf = async (url: URL): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(url).arrayBuffer());

const inputOf = (pdfs: Uint8Array[]): ParsePlUokikDocumentInput => ({
  pdfs,
  caseNumber: "DOK-9/2011",
  court: "Prezes Urzędu Ochrony Konkurencji i Konsumentów",
  decisionDate: "2011-11-28",
  decisionType: "decyzja",
  sourceUrl:
    "https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/1/2520D55B0F17A317C1257EC6007B9773?OpenDocument&act=Decyzja",
  documentUrl: undefined,
  documentId: "2520D55B0F17A317C1257EC6007B9773",
  keywords: [],
});

/**
 * The text every line of the files prints, one paragraph per line, with a
 * word the typesetter broke across two lines ("Konku-" / "rencji") read
 * whole, as a reader reads it.
 */
const printedLines = async (pdfs: Uint8Array[]): Promise<string[]> =>
  (await plUokikDocumentLines(pdfs))
    .flatMap((line) =>
      line.type === "text" ? [line.runs.map(({ text }) => text).join("")] : [],
    )
    .join("\n")
    .replaceAll(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .split("\n");

const hasBold = (inlines: readonly Inline[]): boolean =>
  inlines.some(
    (inline) =>
      inline.type === "bold" ||
      ("children" in inline && hasBold(inline.children)),
  );

const inlinesOf = (block: Block): readonly Inline[] =>
  block.type === "paragraph" || block.type === "heading" ? block.inlines : [];

const LOSS_CODES = new Set([
  "CONTENT_LOSS",
  "MISSING_WORDS",
  "EMPTY_AST",
  "MARKUP_RESIDUE",
]);

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

describe("a UOKiK decision PDF", () => {
  test.each([
    ["a 2011 decision", DOK_9_2011],
    ["a 2024 decision", RGD_16_2024],
  ])("%s keeps every word its text layer prints", async (_, fixture) => {
    const pdfs = [await bytesOf(fixture)];
    const parsed = await parsePlUokikDocument(inputOf(pdfs));
    expect(parsed).not.toBeNull();
    const result = validateAst(
      buildValidationHtml(await printedLines(pdfs)),
      parsed?.documentAst.blocks ?? [],
    );
    expect(result.issues.filter(({ code }) => LOSS_CODES.has(code))).toEqual(
      [],
    );
  });

  test("states the decision it is", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(DOK_9_2011)]),
    );
    expect(parsed?.fulltext).toContain("DOK-9/2011");
    expect(parsed?.fulltext).toContain("Inco-Veritas");
  });

  test("keeps the emphasis the publisher set in a bold face", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(RGD_16_2024)]),
    );
    const blocks = parsed?.documentAst.blocks ?? [];
    expect(blocks.some((block) => hasBold(inlinesOf(block)))).toBe(true);
  });

  test("opens a paragraph at a number set out with a hanging indent", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(RGD_16_2024)]),
    );
    const texts = (parsed?.documentAst.blocks ?? []).map(
      ({ plainText }) => plainText,
    );
    // The operative part's first and second points are paragraphs of their
    // own, not one run-on block.
    const first = texts.findIndex((text) => text.startsWith("I. Na podstawie"));
    const second = texts.findIndex((text) =>
      text.startsWith("II. Na podstawie"),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  test("joins several files in the order the record lists them", async () => {
    const first = await bytesOf(DOK_9_2011);
    const second = await bytesOf(RGD_16_2024);
    const joined = await parsePlUokikDocument(inputOf([first, second]));
    const text = joined?.fulltext ?? "";
    expect(occurrences(text, "Inco-Veritas")).toBeGreaterThan(0);
    expect(text.indexOf("Inco-Veritas")).toBeLessThan(
      text.indexOf("Apartamenty Senatorska"),
    );
    // No paragraph runs across the join: the last line of the first file
    // and the first line of the second never share a block.
    const blocks = joined?.documentAst.blocks ?? [];
    expect(
      blocks.some(
        ({ plainText }) =>
          plainText.includes("Inco-Veritas") &&
          plainText.includes("Apartamenty Senatorska"),
      ),
    ).toBe(false);
  });

  test("records the register as the document's source", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(DOK_9_2011)]),
    );
    expect(parsed?.documentAst.source.system).toBe("decyzje.uokik.gov.pl");
  });

  test("no file with a text layer is no document, not an empty one", async () => {
    expect(await parsePlUokikDocument(inputOf([]))).toBeNull();
  });
});
