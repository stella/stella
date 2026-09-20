import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import { parseRegionalDecision } from "@/api/handlers/case-law/ingestion/parsers/cz-regional";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  assemblePlSnParagraphs,
  plSnParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import {
  markupResidueIn,
  markupResidueSweepRules,
} from "@/api/lib/legal-search/parsers/markup-residue";
import type { MarkupResidueRuleId } from "@/api/lib/legal-search/parsers/markup-residue";

// ── What the rules report ───────────────────────────────────

const RESIDUE_SAMPLES: { rule: MarkupResidueRuleId; sample: string }[] = [
  {
    rule: "rtf-control",
    sample:
      "\\shppict \\pict\\picprop\\shplid1025 \\picw16113\\pich26 před odlišným stanoviskem",
  },
  {
    rule: "rtf-control",
    sample: "Odůvodnění {\\*\\blipuid 5f2a} pokračuje",
  },
  {
    rule: "html-tag",
    sample: '<p class="Standard">Žaloba se zamítá.</p>',
  },
  {
    rule: "html-tag",
    sample: "Soud rozhodl<br/>takto",
  },
  { rule: "xml-marker", sample: '<?xml version="1.0"?> ORZECZENIE' },
  {
    rule: "pdf-object",
    sample: "<< /Type /Font /BaseFont /TimesNewRoman >> endobj",
  },
  { rule: "entity", sample: "Spole&ccaron;nost &amp; syn &#8211; rozsudek" },
  { rule: "digit-run", sample: `Přiloha ${"7".repeat(44)} konec` },
  {
    rule: "hex-run",
    sample: `pngblip ${"89504e470d0a1a0a49484452a3f9".repeat(3)}`,
  },
];

/**
 * Text a court actually writes. Every one of these was a candidate for a
 * false positive: the rules are the reason a parser fix is enforceable
 * across jurisdictions, so a rule that fires on a docket, an account
 * number or a company name would be withdrawn within a week.
 */
const CLEAN_SAMPLES: string[] = [
  "podle § 143 odst. 1 písm. a) o. s. ř.",
  "rozsudek Krajského soudu v Brně č. j. 65 A 3/2025-226",
  "ECLI:CZ:US:2009:Pl.US.st.27.09.1",
  "ECLI:EU:C:2019:189, bod 48",
  "https://nalus.usoud.cz/Search/GetText.aspx?sz=Pl-US-st-27-09_1",
  "obchodní firma Marks & Spencer Czech Republic a.s.",
  "IČO 27074358, DIČ CZ27074358",
  "účet č. 123456-1234567890/0710",
  "tel. +420 222 333 444, ISBN 978-80-7400-590-1",
  "částka 1 500 000,50 Kč a náhrada 25 000 Kč",
  "stížnost č. 34503/97 (rozsudek ESLP ze dne 12. 11. 2008)",
  "spisová značka 3 Tdo 1234/2024-I. a čl. 36 odst. 1 Listiny",
  "hash prefix a3f9c1 v protokolu o předání",
  "wyrok SN z dnia 23 czerwca 1994 r., III ARN 36/94",
];

describe("markupResidueIn", () => {
  test.each(RESIDUE_SAMPLES)(
    "reports $rule for $sample",
    ({ rule, sample }) => {
      expect(markupResidueIn(sample)?.rule).toBe(rule);
    },
  );

  test.each(CLEAN_SAMPLES)("passes %s", (sample) => {
    expect(markupResidueIn(sample)).toBeUndefined();
  });

  test("an excerpt is bounded and starts at the offending text", () => {
    const residue = markupResidueIn(
      `Odůvodnění\n\n\\pict\\pngblip ${"ab".repeat(400)}`,
    );

    expect(residue?.excerpt.startsWith("\\pict")).toBe(true);
    expect(residue?.excerpt.length).toBeLessThanOrEqual(120);
  });
});

// ── One fixture per parser family ───────────────────────────

/**
 * A source format leaks its own encoding in its own shape, so each family
 * is proved twice: a real parse of that family carries no residue, and the
 * raw markup that family would leak is reported.
 */

const usFulltext = (): string =>
  parseUsDecisionHtml({
    html: `
      <html><body>
        <span id="lblDecisionForm">NÁLEZ</span>
        <input id="docContentHidden" value="{\\rtf1\\ansi{\\fonttbl{\\f0\\froman Times New Roman;}}\\pard\\f0\\fs24 Ústavní soud rozhodl takto:\\par Ústavní stížnosti se vyhovuje.\\par {\\*\\shppict{\\pict\\picw16113\\pich26\\pngblip 89504e470d0a1a0a0000000d4948445289504e47}}\\insrsid14565320 1. Odlišné stanovisko soudkyně." />
        <input id="docIdHidden" value="777" />
      </body></html>
    `,
    caseNumber: "Pl.ÚS-st. 27/09",
    ecli: undefined,
    court: "Ústavní soud",
    decisionDate: "2009-04-28",
    decisionType: undefined,
  }).fulltext;

const nssFulltext = (): string =>
  parseNssDecisionHtml({
    caseNumber: "2 As 123/2025",
    ecli: undefined,
    court: "Nejvyšší správní soud",
    decisionDate: "2025-03-15",
    decisionType: "rozsudek",
    sourceUrl: "https://vyhledavac.nssoud.cz/doc/123",
    html: `<html><body>
      <p style="text-align:center"><span style="font-weight:bold">ROZSUDEK</span></p>
      <p>Nejvyšší správní soud rozhodl v senátu složeném z předsedy senátu.</p>
      <p>Kasační stížnost se zamítá podle § 110 odst. 1 s. ř. s.</p>
    </body></html>`,
    detailMetadata: {},
  }).fulltext;

const regionalFulltext = (): string => {
  const style = {
    localId: 1,
    alignment: "left",
    hasSpaceBefore: false,
    hasSpaceAfter: false,
    bold: false,
    italic: false,
  };
  const para = (text: string) => ({
    texts: [{ text, anonStyle: "NORMAL" }],
    styleLocalId: 1,
    tableCellInfo: null,
  });
  return parseRegionalDecision({
    caseNumber: "10 C 123/2025",
    ecli: undefined,
    court: "Obvodní soud pro Prahu 1",
    decisionDate: "2025-01-15",
    decisionType: "rozsudek",
    sourceUrl: "https://rozhodnuti.justice.cz/detail/123",
    header: [para("Obvodní soud pro Prahu 1")],
    verdict: [para("Žaloba se zamítá.")],
    justification: [
      para(
        "Žalobce se domáhal zaplacení částky 1 500 000 Kč s příslušenstvím.",
      ),
    ],
    information: [],
    styles: [style],
    verdictText: "Žaloba se zamítá.",
    justificationText:
      "Žalobce se domáhal zaplacení částky 1 500 000 Kč s příslušenstvím.",
  }).fulltext;
};

const plSnFulltext = (): string => {
  const line = (text: string, indented: boolean): PlSnLine => ({
    type: "text",
    runs: [{ text, bold: false }],
    indented,
  });
  return parsePlDecisionContent({
    caseNumber: "III ARN 36/94",
    ecli: undefined,
    court: "Sąd Najwyższy",
    decisionDate: "1994-06-23",
    decisionType: "wyrok",
    sourceUrl: "https://www.sn.pl/orzeczenia/1",
    documentUrl: "https://www.sn.pl/orzeczenia/1.pdf",
    content: plSnParagraphsToHtml(
      assemblePlSnParagraphs([
        line("Sąd Najwyższy rozpoznał sprawę ze skargi kasacyjnej", true),
        line("powoda i skargę oddalił.", false),
        { type: "blank" },
        line("Uzasadnienie", true),
        line("Izba Skarbowa podzieliła stanowisko Urzędu Skarbowego.", false),
      ]),
    ),
    keywords: [],
    statutes: [],
    documentId: "1",
    sourceSystem: "sn.pl",
  }).fulltext;
};

const PARSER_FAMILIES: {
  family: string;
  fulltext: () => string;
  leak: string;
  rule: MarkupResidueRuleId;
}[] = [
  {
    family: "RTF (cz-us)",
    fulltext: usFulltext,
    leak: "\\*\\shppict\\pict\\picw16113\\pich26\\pngblip 89504e470d0a1a0a0000000d4948445289504e47",
    rule: "rtf-control",
  },
  {
    family: "HTML (cz-nss)",
    fulltext: nssFulltext,
    leak: '<p style="margin:0pt">Kasační stížnost se zamítá.</p>',
    rule: "html-tag",
  },
  {
    family: "JSON (cz-regional)",
    fulltext: regionalFulltext,
    leak: "Žalobce &amp; spol. &#8211; rozsudek",
    rule: "entity",
  },
  {
    family: "PDF-derived (pl-sn)",
    fulltext: plSnFulltext,
    leak: "<< /Type /Font /BaseFont /ABCDEE+TimesNewRoman >> endobj",
    rule: "pdf-object",
  },
];

// ── The documented sweep ────────────────────────────────────

describe("the sweep documented in AGENTS.md", () => {
  test("names every rule's pattern", async () => {
    const doc = await Bun.file(
      path.join(import.meta.dir, "..", "..", "AGENTS.md"),
    ).text();
    const sweepStart = doc.indexOf("FROM case_law_decisions d");
    expect(sweepStart).toBeGreaterThan(0);

    // A rule added to the check and not to the sweep leaves its decisions
    // unfindable, which is the state this whole guard exists to end.
    expect(
      markupResidueSweepRules()
        .filter(
          (rule) =>
            !doc.includes(`d.fulltext ~* '${rule.sqlPattern}'`, sweepStart),
        )
        .map((rule) => rule.id),
    ).toEqual([]);
  });
});

describe("parser families", () => {
  test.each(PARSER_FAMILIES)(
    "$family parses clean and reports its own leak",
    ({ fulltext, leak, rule }) => {
      const parsed = fulltext();

      expect(parsed.length).toBeGreaterThan(0);
      expect(markupResidueIn(parsed)).toBeUndefined();
      expect(markupResidueIn(leak)?.rule).toBe(rule);
    },
  );
});
