import { describe, expect, it } from "bun:test";

import { parseFindokDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-findok";

const fixture = async (): Promise<string> =>
  await Bun.file(
    new URL("__fixtures__/at-findok-bfg-2026.xml", import.meta.url),
  ).text();

describe("Austrian Findok XML parser", () => {
  it("preserves the embedded decision structure and official metadata", async () => {
    const parsed = parseFindokDecisionXml({
      caseNumber: "RV/7500368/2026",
      court: "BFG",
      decisionDate: "2026-07-14",
      decisionType: "bescheidbeschwerde - einzel - erkenntnis",
      sourceDocumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
      sourceUrl: "https://findok.bmf.gv.at/findok/iwg/152/152257/152257.1.pdf",
      xml: await fixture(),
    });

    expect(parsed.ecli).toBe("ECLI:AT:BFG:2026:RV.7500368.2026");
    expect(parsed.keywords).toEqual(["Verwaltungsstrafsachen Wien"]);
    expect(parsed.statutes).toHaveLength(2);
    expect(parsed.documentAst.blocks.at(0)).toMatchObject({
      type: "heading",
      role: "decision-title",
      plainText: "IM NAMEN DER REPUBLIK",
    });
    expect(parsed.fulltext).toContain("Entscheidungsgründe");
    expect(parsed.fulltext).toContain("Rechtliche Würdigung");
    expect(parsed.validationIssues).toEqual([]);
  });

  it("rejects an envelope without decision XHTML", () => {
    expect(() =>
      parseFindokDecisionXml({
        caseNumber: "RV/7500368/2026",
        court: "BFG",
        decisionDate: "2026-07-14",
        decisionType: "erkenntnis",
        sourceDocumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
        sourceUrl: "https://findok.bmf.gv.at/",
        xml: "<Segmente />",
      }),
    ).toThrow("no embedded decision XHTML");
  });
});
