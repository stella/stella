import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assembleHuBhgyDecision,
  huBhgyDocumentOf,
  huBhgyRawPartsOf,
  normalizeHuBhgyRow,
  readHuBhgySearch,
} from "@/api/handlers/case-law/ingestion/adapters/hu-bhgy";
import { huBhgyRetention } from "@/api/handlers/case-law/ingestion/retention/sources/hu-bhgy";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);
const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

/** A row the publisher listed, to file each recorded document under. */
const listedRow = async (): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(
      new URL("hu-bhgy-listing-2000-gazdasagi.json", ADAPTER_FIXTURES),
    ).text(),
  );
  const row = readHuBhgySearch(parsed)?.rows.at(0);
  if (row === undefined) {
    throw new TypeError("the recorded listing carries no row");
  }
  return row;
};

/**
 * The recorded file of each era, and the synthetic RTF the parser's tests
 * use for notes, which is the one shape the recordings do not carry.
 */
const DOCUMENTS = [
  {
    name: "hu-bhgy-decision.docx",
    bytes: async () =>
      await Bun.file(new URL("hu-bhgy-decision.docx", PARSER_FIXTURES)).bytes(),
  },
  {
    name: "hu-bhgy-decision.rtf",
    bytes: async () =>
      await Bun.file(new URL("hu-bhgy-decision.rtf", PARSER_FIXTURES)).bytes(),
  },
  {
    name: "synthetic RTF with footnotes",
    bytes: async () =>
      await Promise.resolve(
        new TextEncoder().encode(
          String.raw`{\rtf1 Rendelkez\u337? r\u233?sz\par Holding text{\footnote Holding note}\par Indokol\u225?s\par Reasoning text{\footnote Reasoning note one\par Reasoning note two}\par Closing text\par}`,
        ),
      ),
  },
] as const;

describe("hu-bhgy retention projection", () => {
  test.each(DOCUMENTS.map((fixture) => [fixture.name, fixture] as const))(
    "the parsed decision keeps the file's text: %s",
    async (_name, fixture) => {
      const row = await listedRow();
      const document = huBhgyDocumentOf(await fixture.bytes());
      if (document === undefined) {
        throw new TypeError("the fixture is neither a Word package nor RTF");
      }
      const built = await assembleHuBhgyDecision({
        row: normalizeHuBhgyRow(row),
        document,
        rawParts: huBhgyRawPartsOf(row, document),
      });
      if (built.type !== "built") {
        throw new Error(`expected a built decision, got ${built.type}`);
      }
      const ast = built.decision.documentAst;
      if (!hasUsableAst(ast)) {
        throw new Error("the fixture built no document");
      }
      const projection = await huBhgyRetention.project(
        built.decision.sourceRaw ?? "",
      );
      if (projection.type !== "source") {
        throw new Error(`expected a source projection, got ${projection.type}`);
      }

      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );

      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
      // The projection measures something: a parse that lost the second half
      // of the decision fails against it.
      const halved = ast.blocks.slice(0, Math.ceil(ast.blocks.length / 2));
      expect(
        validateAst(projection.source, halved, projection.options).ok,
      ).toBe(false);
    },
  );

  test("a listing stored without its file has no publisher text", async () => {
    expect(
      await huBhgyRetention.project(encodeSourceRawEnvelope({ listing: "{}" })),
    ).toEqual({ type: "no-text", reason: "not-published" });
  });

  test("a stored file that opens as neither format is unreadable", async () => {
    const raw = encodeSourceRawEnvelope({
      listing: "{}",
      document: Buffer.from("PK\u0003\u0004 truncated").toString("base64"),
    });

    expect(await huBhgyRetention.project(raw)).toEqual({
      type: "unreadable",
      reason: "unreadable-document",
    });
  });
});
