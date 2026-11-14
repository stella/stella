/**
 * The procurement chamber's converter sets some printed body lines as
 * headings; only its centred headings are the decision's own.
 */

import { describe, expect, test } from "bun:test";

import { load } from "@stll/html";
import type { Block } from "@stll/legal-ast/document-ast";

import { parsePlDecisionContent as uncheckedParsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { readPlKioLayout } from "@/api/handlers/case-law/ingestion/parsers/pl-kio-layout";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parsePlDecisionContent = guardParser(uncheckedParsePlDecisionContent);

const blocksOf = async (
  file: string,
  caseNumber: string,
  documentId: string,
): Promise<Block[]> => {
  const content = new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL(`__fixtures__/${file}`, import.meta.url),
        ).arrayBuffer(),
      ),
    ),
  );
  return parsePlDecisionContent({
    caseNumber,
    ecli: undefined,
    court: "Krajowa Izba Odwoławcza",
    decisionDate: undefined,
    decisionType: "wyrok",
    sourceUrl: undefined,
    documentUrl: undefined,
    content,
    loadHtml: (html) => {
      const $ = load(html);
      readPlKioLayout($);
      return $;
    },
    keywords: [],
    statutes: [],
    documentId,
    superscripts: true,
  }).documentAst.blocks;
};

const headingsOf = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) =>
    block.type === "heading" ? [block.plainText] : [],
  );

describe("converter headings that are body lines", () => {
  test("KIO 1589/18: ruling lines set justified read as the ruling, not as headings", async () => {
    const blocks = await blocksOf(
      "pl-kio-content-9302.html.gz",
      "KIO 1589/18",
      "9302",
    );
    const headings = headingsOf(blocks);
    for (const line of [
      "Dyrektora Dróg Krajowych i Autostrad w Warszawie i:",
      "do Sądu Okręgowego w Warszawie.",
    ]) {
      expect(headings).not.toContain(line);
    }
    expect(headings.filter((text) => text.startsWith("2.2."))).toEqual([]);
    expect(headings).toContain("WYROK");
    const texts = blocks.flatMap((block) =>
      block.type === "paragraph" ? [block.plainText] : [],
    );
    expect(texts).toContain(
      "2. Kosztami postępowania obciąża zamawiającego Skarb Państwa - Generalnego Dyrektora Dróg Krajowych i Autostrad w Warszawie i:",
    );
    expect(
      texts.some((text) =>
        /^2\.2\.\s+zasądza od zamawiającego Skarbu Państwa - Generalnego Dyrektora Dróg Krajowych i Autostrad w Warszawie na rzecz/u.test(
          text,
        ),
      ),
    ).toBe(true);
  });

  test("KIO 115/22: the docket, bench and clerk are not headings", async () => {
    const blocks = await blocksOf(
      "pl-kio-content-16389.html.gz",
      "KIO 115/22",
      "16389",
    );
    const headings = headingsOf(blocks);
    for (const line of [
      "Sygn. akt: KIO 115/22",
      "Przewodniczący: Ewa Sikorska",
      "Protokolant: Aldona Karpińska",
    ]) {
      expect(headings).not.toContain(line);
    }
    expect(headings).toEqual(expect.arrayContaining(["WYROK", "Uzasadnienie"]));
  });
});
