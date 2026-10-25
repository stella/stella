import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { czNssAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  validateAst,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { czNssFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

import { czNssRetention } from "./cz-nss";

const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

const readGzip = async (url: URL): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const projectionOf = async (sourceRaw: string) =>
  czNssRetention.type === "checked"
    ? await czNssRetention.project(sourceRaw)
    : panic("cz-nss is declared unparsed");

/** The oracle's verdict on the adapter's document against the projection. */
const retentionOf = async (
  decision: IngestionResult,
): Promise<ValidationResult> => {
  const ast = decision.documentAst;
  if (!hasUsableAst(ast)) {
    return panic("the adapter built no document");
  }
  const projection = await projectionOf(
    decision.sourceRaw ?? panic("the decision stores no raw"),
  );
  return projection.type === "source"
    ? validateAst(projection.source, ast.blocks, projection.options)
    : panic(`projection answered ${projection.type}`);
};

/** The decision the adapter rebuilds from a stored payload, without I/O. */
const replayed = async (
  caseNumber: string,
  raw: string,
  contentType: string,
): Promise<IngestionResult> => {
  const outcome = await czNssAdapter.reparseStoredRaw?.({
    raw: new TextEncoder().encode(raw),
    contentType,
    caseNumber,
    sourceDocumentId: null,
    language: "cs",
    court: "Nejvyšší správní soud",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  return outcome?.type === "parsed"
    ? outcome.result
    : panic(`${caseNumber} did not replay: ${JSON.stringify(outcome)}`);
};

/** The Aspose exports the parser's own tests read, as the portal served them. */
const RECORDED = [
  { caseNumber: "10 As 124/2025", file: "cz-nss-10-as-124-2025.html.gz" },
  { caseNumber: "10 Azs 28/2026", file: "cz-nss-10-azs-28-2026.html.gz" },
  { caseNumber: "22 As 35/2026", file: "cz-nss-22-as-35-2026.html.gz" },
] as const;

describe("cz-nss retention against the document the portal served", () => {
  for (const fixture of RECORDED) {
    test(`${fixture.caseNumber} keeps its text`, async () => {
      const html = await readGzip(new URL(fixture.file, PARSER_FIXTURES));
      const result = await retentionOf(
        await replayed(
          fixture.caseNumber,
          encodeSourceRawEnvelope({ document: html }),
          SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        ),
      );
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  test("a row stored before the envelope, as bare HTML, projects the same text", async () => {
    const [fixture] = RECORDED;
    const html = await readGzip(new URL(fixture.file, PARSER_FIXTURES));
    const decision = await replayed(fixture.caseNumber, html, "text/html");
    expect(decision.sourceRaw).toBe(html);
    expect((await retentionOf(decision)).ok).toBe(true);
  });

  describe("the enrolled synthetic decision", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("keeps its text", async () => {
      const result = await retentionOf(await czNssFixture().buildDecision());
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  test("the plain-text endpoint's answer is read one line per paragraph", async () => {
    expect(
      await projectionOf(
        encodeSourceRawEnvelope({
          text: "Kasační stížnost se zamítá.<br>Odůvodnění:\r\nŽalobce nesouhlasí &amp; podal stížnost.",
          listing: "{}",
        }),
      ),
    ).toEqual({
      type: "source",
      source: {
        type: "paragraphs",
        paragraphs: [
          "Kasační stížnost se zamítá.",
          "Odůvodnění:",
          "Žalobce nesouhlasí & podal stížnost.",
        ],
      },
    });
  });

  test("an envelope holding neither document has no publisher text", async () => {
    expect(
      await projectionOf(encodeSourceRawEnvelope({ listing: "{}" })),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });
});
