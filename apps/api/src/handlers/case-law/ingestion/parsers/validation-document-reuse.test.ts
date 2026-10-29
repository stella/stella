import { Glob } from "bun";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as cheerio from "cheerio";

import * as astValidation from "@/api/lib/legal-search/parsers/validate-ast";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

import {
  ecjDocumentHtml,
  parseEcjDecisionHtml as uncheckedParseEcjDecisionHtml,
} from "./eu-ecj";

const parseEcjDecisionHtml = guardParser(uncheckedParseEcjDecisionHtml);

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const decoder = new TextDecoder();

const gunzip = async (url: URL): Promise<string> =>
  decoder.decode(Bun.gunzipSync(await Bun.file(url).bytes()));

type ValidateAstArgs = Parameters<typeof astValidation.validateAst>;

type CapturedValidation = {
  source: ValidateAstArgs[0];
  blocks: ValidateAstArgs[1];
  options: ValidateAstArgs[2];
  documentHtml: string | undefined;
};

/**
 * The ECJ parser measures its parse with the tree it already loaded, to
 * choose between that parse and the stripped-text fallback. Capture what it
 * handed the oracle so a fresh load can be compared against the reused one.
 */
const captureValidation = <Result>(parse: () => Result) => {
  const calls: CapturedValidation[] = [];
  const validateAst = astValidation.validateAst;
  const validateSpy = spyOn(astValidation, "validateAst").mockImplementation(
    (...args: ValidateAstArgs) => {
      const [source, blocks, options] = args;
      calls.push({
        source,
        blocks,
        options,
        // validateAst mutates the supplied tree while extracting source text.
        // Preserve what the parser handed over, before validation starts.
        documentHtml: options?.document?.html(),
      });
      return validateAst(...args);
    },
  );

  try {
    const result = parse();
    expect(calls).toHaveLength(1);
    const call = calls.at(0);
    if (call === undefined) {
      throw new Error("parser did not measure its document");
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
  const reused = astValidation.validateAst(call.source, call.blocks, {
    ...options,
    document: cheerio.load(call.documentHtml),
  });
  const fresh = astValidation.validateAst(call.source, call.blocks, options);
  return Bun.deepEquals(reused, fresh);
};

describe("validation document reuse", () => {
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
      expect(validationResultsMatch(call)).toBeTrue();
    }
  });

  test("a mutated document measures differently from its source", () => {
    const secret = "never validate this replacement as the original";
    const xhtml =
      `<p><span style="font-size: 12px">PUBLIC HEADING</span><br/>` +
      `<span style="color: #000000; background-color: #000000; font-size: 12px">${secret}</span></p>`;
    const blocks: ValidateAstArgs[1] = [
      {
        id: "p1",
        anchorId: "p1",
        type: "paragraph",
        plainText: `PUBLIC HEADING ${secret}`,
        inlines: [{ type: "text", text: `PUBLIC HEADING ${secret}` }],
      },
    ];
    const mutated = cheerio.load(xhtml);
    mutated("span").last().text("anonymizované");

    expect(
      astValidation.validateAst(xhtml, blocks, { document: mutated }),
    ).not.toEqual(astValidation.validateAst(xhtml, blocks));
  });

  test("rejects a caller that mutates its document before validation", () => {
    const sourceHtml = "<body><p>original source words</p></body>";
    const { call } = captureValidation(() => {
      const document = cheerio.load(sourceHtml);
      document("p").text("replacement words");
      return astValidation.validateAst(
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
