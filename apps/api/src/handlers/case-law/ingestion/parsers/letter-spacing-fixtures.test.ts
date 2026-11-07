/**
 * Letter-spaced emphasis in recorded decisions, read the one way the owner
 * (`collapseLetterSpacing` in `@stll/text-normalize`) reads it, in every
 * parser that meets it. Asserted on the text the stored inlines draw, not
 * only on the folded `plainText`: a reader shows the inlines.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { load } from "@stll/html";
import { type Block, plainTextOf } from "@stll/legal-ast/document-ast";

import { parseNsDecisionHtml as uncheckedParseNsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import {
  parsePlDecisionContent as uncheckedParsePlDecisionContent,
  PL_DECISION_MARKUP,
} from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { readPlKioLayout } from "@/api/handlers/case-law/ingestion/parsers/pl-kio-layout";
import { readPlNcourtContent } from "@/api/handlers/case-law/ingestion/parsers/pl-ncourt";
import { parseSkUsDocumentXhtml as uncheckedParseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { parseSkDecisionPdf as uncheckedParseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseNsDecisionHtml = guardParser(uncheckedParseNsDecisionHtml);
const parsePlDecisionContent = guardParser(uncheckedParsePlDecisionContent);
const parseSkUsDocumentXhtml = guardParser(uncheckedParseSkUsDocumentXhtml);
const parseSkDecisionPdf = guardParser(uncheckedParseSkDecisionPdf);

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const bytesOf = async (name: string): Promise<Uint8Array> => {
  const bytes = new Uint8Array(
    await Bun.file(new URL(name, FIXTURES)).arrayBuffer(),
  );
  return name.endsWith(".gz") ? new Uint8Array(gunzipSync(bytes)) : bytes;
};

const textOf = async (name: string): Promise<string> =>
  new TextDecoder().decode(await bytesOf(name));

type Read = { type: Block["type"]; role: string | undefined; text: string };

/** Paragraphs and headings as the reader draws their inlines. */
const read = (blocks: readonly Block[]): Read[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph" || block.type === "heading"
      ? [
          {
            type: block.type,
            role: block.role,
            text: plainTextOf(block.inlines).replaceAll(/\s+/gu, " ").trim(),
          },
        ]
      : [],
  );

/** Four single letters a space apart: a spaced word left unread. */
const SPACED_RUN = /(?<!\S)(?:\p{L}\p{M}* ){3}\p{L}(?!\S)/u;

const unreadRuns = (blocks: readonly Read[]): string[] =>
  blocks.flatMap(({ text }) => (SPACED_RUN.test(text) ? [text] : []));

describe("Slovak Constitutional Court: IV. ÚS 135/2025", () => {
  const blocks = async () => {
    const payload: unknown = JSON.parse(
      await textOf("sk-us-iv-us-135-2025.content.json.gz"),
    );
    const content =
      typeof payload === "object" &&
      payload !== null &&
      "content" in payload &&
      typeof payload.content === "string"
        ? payload.content
        : "";
    expect(content).not.toBe("");
    return read(
      parseSkUsDocumentXhtml({
        xhtml: Buffer.from(content, "base64").toString("utf-8"),
        caseNumber: "IV. ÚS 135/2025",
        ecli: undefined,
        court: "Ústavný súd SR",
        decisionDate: undefined,
        decisionType: undefined,
        documentUrl: "https://www.ustavnysud.sk/docDownload/fixture",
      }).documentAst.blocks,
    );
  };

  // The file cuts its spaced verbs into uneven chunks no line prints whole:
  // `p ri k azu je`, `n evyh ovu je.`
  test("the operative verbs read whole", async () => {
    const holding = (await blocks()).filter(({ role }) => role === "holding");
    expect(holding.map(({ text }) => text)).toEqual([
      expect.stringContaining("B2-8C/7/2022 bolo porušené základné právo"),
      "2. Mestskému súdu Bratislava IV prikazuje v konaní sp. zn. B2-8C/7/2022 konať bez zbytočných prieťahov.",
      expect.stringContaining(
        "3. Mestský súd Bratislava IV je povinný nahradiť",
      ),
      "4. Vo zvyšnej časti ústavnej sťažnosti nevyhovuje.",
    ]);
  });

  test("NÁLEZ is the decision's title", async () => {
    expect((await blocks()).slice(0, 2)).toEqual([
      { type: "paragraph", role: "intro", text: "SLOVENSKÁ REPUBLIKA" },
      { type: "heading", role: "decision-title", text: "NÁLEZ" },
    ]);
  });
});

describe("short spaced words beside spaced verbs", () => {
  test("Supreme Court 5 Tdo 242/2005: `s e` reads `se`", async () => {
    const parsed = parseNsDecisionHtml({
      documentId: "fixture",
      webUrl: "https://rozhodnuti.nsoud.cz/fixture",
      printUrl: "https://rozhodnuti.nsoud.cz/fixture/print",
      webHtml: "",
      printHtml: await textOf("cz-ns-5-tdo-242-2005.print.html.gz"),
    });
    const holding = read(parsed.documentAst.blocks)
      .filter(({ role }) => role === "holding")
      .map(({ text }) => text);
    expect(holding).toContainEqual(
      expect.stringMatching(
        /^Podle § 265k odst\. 1 tr\. ř\. se zrušují rozsudek /u,
      ),
    );
    expect(holding).toContainEqual(
      expect.stringMatching(
        /^Podle § 265l odst\. 1 tr\. ř\. se Okresnímu soudu ve Svitavách přikazuje, aby /u,
      ),
    );
  });

  // The text layer keeps the gaps only roughly, and breaks `j e` over a line.
  test("district court 19C/150/2006: `j e` over a line and `s a` read as words", async () => {
    const parsed = await parseSkDecisionPdf({
      pdfBytes: await bytesOf("sk-courts-19c-150-2006.pdf"),
      caseNumber: "19C/150/2006",
      ecli: undefined,
      court: "Okresný súd Trenčín",
      decisionDate: undefined,
      decisionType: undefined,
    });
    const blocks = read(parsed.documentAst.blocks);
    const holding = blocks.filter(({ role }) => role === "holding");
    expect(holding.map(({ text }) => text)).toEqual([
      "Určuje sa, že výpoveď daná žalobcovi listom žalovaného, ktorá bola doručená žalobcovi 7.8.2006 je neplatná.",
      "Žalobcovi sa náhrada trov konania nepriznáva.",
    ]);
    expect(unreadRuns(blocks)).toEqual([]);
  });
});

describe("Polish courts read spaced headings and verbs as words", () => {
  test("KIO 1589/18: the reasons heading", async () => {
    const { documentAst } = parsePlDecisionContent({
      caseNumber: "KIO 1589/18",
      ecli: undefined,
      court: "Krajowa Izba Odwoławcza",
      decisionDate: undefined,
      decisionType: "wyrok",
      sourceUrl: undefined,
      documentUrl: undefined,
      content: await textOf("pl-kio-content-9302.html.gz"),
      loadHtml: (html) => {
        const $ = load(html);
        readPlKioLayout($);
        return $;
      },
      keywords: [],
      statutes: [],
      documentId: "9302",
      superscripts: true,
    });
    const blocks = read(documentAst.blocks);
    expect(blocks.map(({ text }) => text)).toContain("Uzasadnienie");
    expect(unreadRuns(blocks)).toEqual([]);
  });

  test("IV Kz 73/19: the operative verb", async () => {
    const content = readPlNcourtContent(
      await textOf("pl-ncourt-iv-kz-73-19.xml.gz"),
    );
    expect(content).not.toBeNull();
    const { documentAst } = parsePlDecisionContent({
      caseNumber: "IV Kz 73/19",
      ecli: undefined,
      court: "Sąd Okręgowy w Legnicy",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      documentUrl: undefined,
      content: content?.html ?? "",
      keywords: [],
      statutes: [],
      documentId: "IV Kz 73/19",
      sourceSystem: "orzeczenia.ms.gov.pl",
      superscripts: true,
      markup: PL_DECISION_MARKUP.COMMON_COURT,
    });
    const blocks = read(documentAst.blocks);
    expect(blocks.map(({ text }) => text)).toContain("postanawia");
    expect(unreadRuns(blocks)).toEqual([]);
  });

  test("II UKN 93/00: legacy plain text", async () => {
    const payload: unknown = JSON.parse(
      await textOf("pl-courts-saos-80119.json.gz"),
    );
    const data =
      typeof payload === "object" && payload !== null && "data" in payload
        ? payload.data
        : undefined;
    const content =
      typeof data === "object" &&
      data !== null &&
      "textContent" in data &&
      typeof data.textContent === "string"
        ? data.textContent
        : "";
    expect(content).not.toBe("");
    const { documentAst } = parsePlDecisionContent({
      caseNumber: "II UKN 93/00",
      ecli: undefined,
      court: "Sąd Najwyższy",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      documentUrl: undefined,
      content,
      keywords: [],
      statutes: [],
      documentId: "80119",
      superscripts: true,
      markup: PL_DECISION_MARKUP.COMMON_COURT,
    });
    const text = read(documentAst.blocks)
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("oddalił kasację.");
    expect(text).toContain("Uzasadnienie");
    expect(unreadRuns(read(documentAst.blocks))).toEqual([]);
  });
});
