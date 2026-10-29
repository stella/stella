import { Glob } from "bun";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as cheerio from "cheerio";
import * as v from "valibot";

import * as astValidation from "@/api/lib/legal-search/parsers/validate-ast";

import { parseNssDecisionHtml } from "./cz-nss";
import { ecjDocumentHtml, parseEcjDecisionHtml } from "./eu-ecj";
import { parsePlDecisionContent } from "./pl-courts";
import {
  parsePlTkPage,
  parsePlTkText,
  readPlTkCasePage,
  readPlTkRuling,
} from "./pl-tk";
import { parseSkUsDocumentXhtml } from "./sk-us";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const ADAPTER_FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);
const decoder = new TextDecoder();
const saosFixtureSchema = v.object({
  data: v.object({ textContent: v.string() }),
});

const gunzip = async (url: URL): Promise<string> =>
  decoder.decode(Bun.gunzipSync(await Bun.file(url).bytes()));

type ValidateAndLogArgs = Parameters<typeof astValidation.validateAndLog>;

type CapturedValidation = {
  sourceHtml: ValidateAndLogArgs[1];
  blocks: ValidateAndLogArgs[2];
  options: ValidateAndLogArgs[3];
  documentHtml: string | undefined;
};

const captureValidation = <Result>(parse: () => Result) => {
  const calls: CapturedValidation[] = [];
  const validateAndLog = astValidation.validateAndLog;
  const validateSpy = spyOn(astValidation, "validateAndLog").mockImplementation(
    (...args: ValidateAndLogArgs) => {
      const [, sourceHtml, blocks, options] = args;
      calls.push({
        sourceHtml,
        blocks,
        options,
        // validateAst mutates the supplied tree while extracting source text.
        // Preserve what the parser handed over, before validation starts.
        documentHtml: options?.document?.html(),
      });
      return validateAndLog(...args);
    },
  );

  try {
    const result = parse();
    expect(calls).toHaveLength(1);
    const call = calls.at(0);
    if (call === undefined) {
      throw new Error("parser did not validate its document");
    }
    return { result, call };
  } finally {
    validateSpy.mockRestore();
  }
};

const validationResultsMatch = (call: CapturedValidation): boolean => {
  if (call.documentHtml === undefined) {
    throw new Error("parser validation did not receive a parsed document");
  }
  const { document: _document, ...options } = call.options ?? {};
  const reused = astValidation.validateAst(call.sourceHtml, call.blocks, {
    ...options,
    document: cheerio.load(call.documentHtml),
  });
  const fresh = astValidation.validateAst(
    call.sourceHtml,
    call.blocks,
    options,
  );
  return Bun.deepEquals(reused, fresh);
};

const expectCapturedDocumentMatchesFreshParse = (
  call: CapturedValidation,
): void => {
  expect(validationResultsMatch(call)).toBeTrue();
};

describe("validation document reuse", () => {
  test("matches a fresh parse for every NSS fixture", async () => {
    for await (const name of new Glob("cz-nss-*.html.gz").scan(
      FIXTURES.pathname,
    )) {
      const html = await gunzip(new URL(name, FIXTURES));
      const { call } = captureValidation(() =>
        parseNssDecisionHtml({
          caseNumber: name,
          ecli: undefined,
          court: "Nejvyšší správní soud",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          html,
          detailMetadata: {},
        }),
      );
      expectCapturedDocumentMatchesFreshParse(call);
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
      const { call } = captureValidation(() =>
        parseEcjDecisionHtml({
          caseNumber: name,
          ecli: undefined,
          court: "Court of Justice",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          language: undefined,
          celex: name,
          html,
        }),
      );
      expectCapturedDocumentMatchesFreshParse(call);
    }
  });

  test("matches a fresh parse for every SAOS HTML fixture", async () => {
    for (const name of [
      "pl-courts-detail-common.json.gz",
      "pl-courts-detail-chamber.json.gz",
    ]) {
      const payload = v.parse(
        saosFixtureSchema,
        JSON.parse(await gunzip(new URL(name, ADAPTER_FIXTURES))),
      );
      const content = payload.data.textContent;
      if (!/<[a-z][\s\S]*>/iu.test(content)) {
        continue;
      }
      const { call } = captureValidation(() =>
        parsePlDecisionContent({
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
        }),
      );
      expectCapturedDocumentMatchesFreshParse(call);
    }
  });

  // TK blocks are built from the case page DOM the adapter already parsed, so
  // validation's own parse of the ruling fragment is the only one left: it
  // receives no document and must validate the same fragment as before.
  test("validates every TK ruling from its own single fragment parse", async () => {
    for await (const name of new Glob("pl-tk-case-*.html.gz").scan(
      FIXTURES.pathname,
    )) {
      const parsedPage = parsePlTkPage(await gunzip(new URL(name, FIXTURES)));
      const page = readPlTkCasePage(parsedPage);
      if (page === null) {
        throw new Error(`fixture ${name} is not a TK case page`);
      }
      const caseNumber = page.record.caseNumber;
      if (caseNumber === undefined) {
        throw new Error(`fixture ${name} has no case number`);
      }
      for (const rulingId of page.rulingIds) {
        const ruling = readPlTkRuling(parsedPage, rulingId);
        if (ruling === null) {
          throw new Error(`fixture ${name} has no ruling ${rulingId}`);
        }
        const textHtml = ruling.textHtml;
        if (textHtml === undefined) {
          continue;
        }
        const { call } = captureValidation(() =>
          parsePlTkText({
            page: parsedPage,
            caseNumber,
            court: "Trybunał Konstytucyjny",
            decisionDate: ruling.decisionDate,
            decisionType: ruling.decisionForm,
            documentId: rulingId,
            sourceUrl: "",
            documentUrl: undefined,
            textHtml,
          }),
        );
        expect(call.documentHtml).toBeUndefined();
        expect(call.sourceHtml).toBe(`<body>${textHtml}</body>`);
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

  test("rejects a caller that mutates its document before validation", () => {
    const sourceHtml = "<body><p>original source words</p></body>";
    const { call } = captureValidation(() => {
      const document = cheerio.load(sourceHtml);
      document("p").text("replacement words");
      return astValidation.validateAndLog(
        { parser: "mutation-regression", caseNumber: "test" },
        sourceHtml,
        [
          {
            id: "mutation-paragraph",
            anchorId: "mutation-paragraph",
            type: "paragraph",
            plainText: "original source words",
            inlines: [{ type: "text", text: "original source words" }],
          },
        ],
        { document },
      );
    });

    expect(validationResultsMatch(call)).toBeFalse();
  });
});
