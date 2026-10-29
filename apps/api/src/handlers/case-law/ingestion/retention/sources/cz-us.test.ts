import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { czUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  validateAst,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { czUsFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

import { czUsRetention } from "./cz-us";

const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

const readGzip = async (url: URL): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const projectionOf = async (sourceRaw: string) =>
  czUsRetention.type === "checked"
    ? await czUsRetention.project(sourceRaw)
    : panic("cz-us is declared unparsed");

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
  const outcome = await czUsAdapter.reparseStoredRaw?.({
    raw: new TextEncoder().encode(raw),
    contentType,
    caseNumber,
    sourceDocumentId: "nalus-record:1",
    language: "cs",
    court: "Ústavní soud",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1-26_1",
    documentUrl: null,
    metadata: {},
  });
  return outcome?.type === "parsed"
    ? outcome.result
    : panic(`${caseNumber} did not replay: ${JSON.stringify(outcome)}`);
};

/** Document pages the parser's own tests read, as NALUS served them. */
const RECORDED = [
  { caseNumber: "III.ÚS 2429/24", file: "cz-us-iii-us-2429-24.html.gz" },
  { caseNumber: "IV.ÚS 1394/24", file: "cz-us-iv-us-1394-24.html.gz" },
  { caseNumber: "IV.ÚS 422/26", file: "cz-us-iv-us-422-26.html.gz" },
] as const;

/** A page shaped as the adapter's own tests serve one, with no embedded RTF. */
const VISIBLE_ONLY_PAGE = `<html><body>
  <span id="lblRegistrySign">I.ÚS 42/24 ze dne 3. 2. 2004</span>
  <span id="lblDecisionForm">Nález</span>
  <input name="registrySignHidden" value="I.ÚS 42/24 #1 ze dne 3. 2. 2004" />
  <table class="DocContent"><tr><td>
    Ústavní soud rozhodl o ústavní stížnosti takto: Ústavní stížnost se zamítá.<br>
    Odůvodnění: Stěžovatel napadl rozsudek krajského soudu, který podle něj
    porušil jeho právo na spravedlivý proces.<br>
    Jan Novák (soudce zpravodaj)
  </td></tr></table>
</body></html>`;

describe("cz-us retention against the document page NALUS served", () => {
  for (const fixture of RECORDED) {
    test(`${fixture.caseNumber} keeps its text`, async () => {
      const html = await readGzip(new URL(fixture.file, PARSER_FIXTURES));
      const result = await retentionOf(
        await replayed(
          fixture.caseNumber,
          encodeSourceRawEnvelope({ listing: "", document: html }),
          SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        ),
      );
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  test("a row stored as the bare page projects the same text", async () => {
    const [fixture] = RECORDED;
    const html = await readGzip(new URL(fixture.file, PARSER_FIXTURES));
    const decision = await replayed(fixture.caseNumber, html, "text/html");
    expect(decision.sourceRaw).toBe(html);
    expect((await retentionOf(decision)).ok).toBe(true);
  });

  test("a page shaped as the adapter tests serve one keeps its text", async () => {
    const decision = await replayed(
      "I.ÚS 42/24",
      VISIBLE_ONLY_PAGE,
      "text/html",
    );
    const result = await retentionOf(decision);
    expect(result.stats.missingWords).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a pre-envelope JSON row is read from its page", async () => {
    expect(
      (await projectionOf(JSON.stringify({ textHtml: VISIBLE_ONLY_PAGE })))
        .type,
    ).toBe("source");
    expect((await projectionOf(JSON.stringify({ other: 1 }))).type).toBe(
      "unreadable",
    );
  });

  describe("the enrolled synthetic decision", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("keeps its text", async () => {
      const result = await retentionOf(await czUsFixture().buildDecision());
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  test("the region is read line by line, without the page around it", async () => {
    expect(
      await projectionOf(
        `<html><body><div id="menu">Vyhledávání</div><input id="docContentHidden" value="{\\rtf1 Skrytý text}" /><div class="DocContent">První odstavec.<br/><br/>Druhý<br>odstavec.<script>stopa()</script></div></body></html>`,
      ),
    ).toEqual({
      type: "source",
      source: {
        type: "paragraphs",
        paragraphs: ["První odstavec.", "Druhý", "odstavec."],
      },
    });
    expect(
      (await projectionOf("<html><body><p>Bez dokumentu.</p></body></html>"))
        .type,
    ).toBe("unreadable");
  });
});
