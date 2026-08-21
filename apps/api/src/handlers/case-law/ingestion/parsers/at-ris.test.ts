import { describe, expect, it } from "bun:test";

import { parseRisDecisionXml } from "./at-ris";

const FIXTURE_URL = new URL(
  "__fixtures__/at-ris-jjt-1925.xml",
  import.meta.url,
);

describe("Austrian RIS XML parser", () => {
  it("preserves the publisher's sections and operative-part role", async () => {
    const xml = await Bun.file(FIXTURE_URL).text();
    const parsed = parseRisDecisionXml({
      sourceDocumentId: "JJT_19250416_OGH0002_0030OB00270_2500000_000",
      caseNumber: "3Ob270/25",
      ecli: "ECLI:AT:OGH0002:1925:0030OB00270.25.0416.000",
      court: "OGH",
      decisionDate: "1925-04-16",
      decisionType: "beschluss",
      sourceUrl:
        "https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=JJT_19250416_OGH0002_0030OB00270_2500000_000",
      xml,
    });

    expect(parsed.validationIssues).toEqual([]);
    expect(parsed.documentAst.source.documentId).toBe(
      "JJT_19250416_OGH0002_0030OB00270_2500000_000",
    );
    expect(parsed.documentAst.blocks.length).toBeGreaterThan(20);
    expect(
      parsed.documentAst.blocks.some(
        (block) => block.type === "heading" && block.plainText === "Spruch",
      ),
    ).toBe(true);
    expect(
      parsed.documentAst.blocks.some(
        (block) =>
          block.type === "paragraph" &&
          block.role === "holding" &&
          block.plainText.startsWith("Einstweilige Verfügung"),
      ),
    ).toBe(true);
    expect(parsed.fulltext).toContain("Rechtliche Beurteilung");
    expect(parsed.fulltext).not.toContain("www.ris.bka.gv.at");
  });

  it("rejects a payload without publisher document content", () => {
    expect(() =>
      parseRisDecisionXml({
        sourceDocumentId: "JJT_20260115_OGH0002_0010OB00001_26A0000_000",
        caseNumber: "1 Ob 1/26a",
        ecli: undefined,
        court: "OGH",
        decisionDate: "2026-01-15",
        decisionType: "beschluss",
        sourceUrl: undefined,
        xml: "<risdok />",
      }),
    ).toThrow("RIS XML has no nutzdaten element");
  });

  it("rejects an empty publisher document instead of storing a hollow AST", () => {
    expect(() =>
      parseRisDecisionXml({
        sourceDocumentId: "JJT_20260115_OGH0002_0010OB00001_26A0000_000",
        caseNumber: "1 Ob 1/26a",
        ecli: undefined,
        court: "OGH",
        decisionDate: "2026-01-15",
        decisionType: "beschluss",
        sourceUrl: undefined,
        xml: "<risdok><nutzdaten><abschnitt /></nutzdaten></risdok>",
      }),
    ).toThrow("RIS XML nutzdaten element has no decision text");
  });

  it("retains text from an unknown publisher element", async () => {
    const fixture = await Bun.file(FIXTURE_URL).text();
    const xml = fixture.replace(
      "</abschnitt></nutzdaten>",
      "<hinweis>Unbekannter strukturierter Inhalt</hinweis></abschnitt></nutzdaten>",
    );
    const parsed = parseRisDecisionXml({
      sourceDocumentId: "JJT_19250416_OGH0002_0030OB00270_2500000_000",
      caseNumber: "3Ob270/25",
      ecli: "ECLI:AT:OGH0002:1925:0030OB00270.25.0416.000",
      court: "OGH",
      decisionDate: "1925-04-16",
      decisionType: undefined,
      sourceUrl: undefined,
      xml,
    });

    expect(parsed.fulltext).toContain("Unbekannter strukturierter Inhalt");
    expect(parsed.validationIssues).toEqual([]);
  });
});
