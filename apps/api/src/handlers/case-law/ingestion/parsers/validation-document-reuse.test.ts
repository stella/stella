import { Glob } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import * as cheerio from "cheerio";

import * as astValidation from "@/api/lib/legal-search/parsers/validate-ast";

import { parseNssDecisionHtml } from "./cz-nss";
import { ecjDocumentHtml, parseEcjDecisionHtml } from "./eu-ecj";
import { parsePlDecisionContent } from "./pl-courts";
import { parsePlTkText, readPlTkCasePage, readPlTkRuling } from "./pl-tk";
import { parseSkUsDocumentXhtml } from "./sk-us";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const ADAPTER_FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);
const decoder = new TextDecoder();

const gunzip = async (url: URL): Promise<string> =>
  decoder.decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const expectReuseMatchesFreshParse = (
  sourceHtml: string,
  blocks: Parameters<typeof astValidation.validateAst>[1],
  reusedDocument: cheerio.CheerioAPI,
): void => {
  expect(
    astValidation.validateAst(sourceHtml, blocks, {
      document: reusedDocument,
    }),
  ).toEqual(astValidation.validateAst(sourceHtml, blocks));
};

describe("validation document reuse", () => {
  test("matches a fresh parse for every NSS fixture", async () => {
    for await (const name of new Glob("cz-nss-*.html.gz").scan(
      FIXTURES.pathname,
    )) {
      const html = await gunzip(new URL(name, FIXTURES));
      const parsed = parseNssDecisionHtml({
        caseNumber: name,
        ecli: undefined,
        court: "Nejvyšší správní soud",
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: undefined,
        html,
        detailMetadata: {},
      });
      expectReuseMatchesFreshParse(
        html,
        parsed.documentAst.blocks,
        cheerio.load(html),
      );
    }
  });

  test("matches a fresh parse for every whole-document ECJ fixture", async () => {
    const directory = new URL("eu-ecj/", FIXTURES);
    for await (const name of new Glob("*.html.gz").scan(directory.pathname)) {
      const html = await gunzip(new URL(name, directory));
      const source = ecjDocumentHtml(html);
      if (source.boundary !== "document") {
        continue;
      }
      const parsed = parseEcjDecisionHtml({
        caseNumber: name,
        ecli: undefined,
        court: "Court of Justice",
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: undefined,
        language: undefined,
        celex: name,
        html,
      });
      expectReuseMatchesFreshParse(
        html,
        parsed.documentAst.blocks,
        cheerio.load(html),
      );
    }
  });

  test("matches a fresh parse for every SAOS HTML fixture", async () => {
    for (const name of [
      "pl-courts-detail-common.json.gz",
      "pl-courts-detail-chamber.json.gz",
    ]) {
      const payload = JSON.parse(
        await gunzip(new URL(name, ADAPTER_FIXTURES)),
      ) as { data: { textContent: string } };
      const content = payload.data.textContent;
      if (!/<[a-z][\s\S]*>/iu.test(content)) {
        continue;
      }
      const parsed = parsePlDecisionContent({
        caseNumber: name,
        ecli: undefined,
        court: "",
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: "",
        documentUrl: "",
        content,
        keywords: [],
        statutes: [],
        documentId: name,
      });
      expectReuseMatchesFreshParse(
        content,
        parsed.documentAst.blocks,
        cheerio.load(content),
      );
    }
  });

  test("matches a fresh parse for every ruling in every TK fixture", async () => {
    for await (const name of new Glob("pl-tk-case-*.html.gz").scan(
      FIXTURES.pathname,
    )) {
      const pageHtml = await gunzip(new URL(name, FIXTURES));
      const page = readPlTkCasePage(pageHtml);
      expect(page).not.toBeNull();
      for (const rulingId of page?.rulingIds ?? []) {
        const ruling = readPlTkRuling(pageHtml, rulingId);
        const textHtml = ruling?.textHtml;
        if (textHtml === undefined) {
          continue;
        }
        const sourceHtml = `<body>${textHtml}</body>`;
        const parsed = parsePlTkText({
          caseNumber: page.record.caseNumber,
          court: "Trybunał Konstytucyjny",
          decisionDate: ruling.decisionDate,
          decisionType: ruling.decisionForm,
          documentId: rulingId,
          sourceUrl: "",
          documentUrl: undefined,
          textHtml,
        });
        expectReuseMatchesFreshParse(
          sourceHtml,
          parsed.documentAst.blocks,
          cheerio.load(sourceHtml),
        );
      }
    }
  });

  test("a hidden SK-US run proves a mutated document cannot be reused", () => {
    const secret = "never validate this replacement as the original";
    const xhtml =
      `<p><span style="font-size: 12px">PUBLIC HEADING</span><br/>` +
      `<span style="color: #000000; background-color: #000000; font-size: 12px">${secret}</span></p>`;
    const validate = spyOn(astValidation, "validateAndLog");
    const parsed = parseSkUsDocumentXhtml({
      xhtml,
      caseNumber: "I. ÚS 1/2026",
      ecli: undefined,
      court: "Ústavný súd SR",
      decisionDate: undefined,
      decisionType: undefined,
      documentUrl: "https://example.invalid/decision",
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]?.[3]).toBeUndefined();
    validate.mockRestore();
    const mutated = cheerio.load(xhtml);
    mutated("span").last().text("anonymizované");

    expect(
      astValidation.validateAst(xhtml, parsed.documentAst.blocks, {
        document: mutated,
      }),
    ).not.toEqual(astValidation.validateAst(xhtml, parsed.documentAst.blocks));
  });
});
