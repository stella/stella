import { Result } from "better-result";
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
    }).unwrap();

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
    const parsed = parseFindokDecisionXml({
      caseNumber: "RV/7500368/2026",
      court: "BFG",
      decisionDate: "2026-07-14",
      decisionType: "erkenntnis",
      sourceDocumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
      sourceUrl: "https://findok.bmf.gv.at/",
      xml: "<Segmente />",
    });

    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      expect(parsed.error.message).toContain("no embedded decision XHTML");
    }
  });
});

it("excludes script and style text from embedded XHTML and validation", () => {
  const parsed = parseFindokDecisionXml({
    caseNumber: "RV/1/2026",
    court: "BFG",
    decisionDate: "2026-07-14",
    decisionType: "erkenntnis",
    sourceDocumentId: "test",
    sourceUrl: "https://findok.bmf.gv.at/",
    xml: "<Segmente><Segk><txt><![CDATA[<body><h1>Title</h1><script>script-only</script><style>style-only</style><p>Visible<script>nested-script</script><style>nested-style</style> decision</p></body>]]></txt></Segk></Segmente>",
  }).unwrap();
  expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
    "Title",
    "Visible decision",
  ]);
  expect(parsed.fulltext).toBe("Title\n\nVisible decision");
  expect(parsed.validationIssues).toEqual([]);
});
