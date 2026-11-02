import { describe, expect, it } from "bun:test";

import type { Block, ParagraphRole } from "@stll/legal-ast/document-ast";

import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";

import {
  type AtCourtTextSection,
  type AtPrintedLine,
  readAtDecisionRoles,
} from "./at-decision-regions";
import { parseFindokDecisionXml } from "./at-findok";
import { parseRisDecisionXml } from "./at-ris";

type Expected = readonly (readonly [string, ParagraphRole | undefined])[];

const fixtureText = async (name: string): Promise<string> =>
  await Bun.file(new URL(`__fixtures__/${name}`, import.meta.url)).text();

const risBlocks = async (
  name: string,
  caseNumber: string,
): Promise<Block[]> => {
  const parsed = parseRisDecisionXml({
    sourceDocumentId: name,
    caseNumber,
    ecli: undefined,
    court: "x",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    xml: await fixtureText(name),
  }).unwrap();
  return parsed.documentAst.blocks;
};

/** The role of the first paragraph that starts with `prefix`. */
const rolesOf = (blocks: readonly Block[], expected: Expected) =>
  expected.map(([prefix]) => {
    const block = blocks.find(
      (candidate) =>
        candidate.type === "paragraph" &&
        candidate.plainText.startsWith(prefix),
    );
    if (block?.type !== "paragraph") {
      throw new Error(`no paragraph starts with ${prefix}`);
    }
    return [prefix, block.role] as const;
  });

const RIS_CASES = [
  {
    name: "BVwG: docket, abridgement, formula and bench filed under Spruch",
    fixture: "at-ris-bvwg-beschluss.xml",
    caseNumber: "W224 2231206-1",
    expected: [
      ["W224 2231206-1/13E", "case-number"],
      ["GEKÜRZTE AUSFERTIGUNG", "intro"],
      ["IM NAMEN DER REPUBLIK", "intro"],
      ["Das Bundesverwaltungsgericht hat durch", "intro"],
      ["A) Der Beschwerde wird", "holding"],
      ["B) Die Revision ist", "holding"],
      ["Gemäß § 29 Abs. 5", "argumentation"],
    ],
  },
  {
    name: "LVwG: the whole decision filed under Text",
    fixture: "at-ris-lvwg-noe.xml",
    caseNumber: "LVwG-AV-2413/001-2023",
    expected: [
      ["IM NAMEN DER REPUBLIK", "intro"],
      ["Das Landesverwaltungsgericht Niederösterreich erkennt", "intro"],
      ["1. Der Beschwerde wird", "holding"],
      ["2. Gegen dieses Erkenntnis", "holding"],
      ["Entscheidungsgründe", "argumentation"],
      ["Die ordentliche Revision ist nicht zulässig", "argumentation"],
    ],
  },
  {
    name: "Bundesvergabeamt: recital, then a Spruch label",
    fixture: "at-ris-verg-bva.xml",
    caseNumber: "N/0108-BVA/02/2012-22",
    expected: [
      ["BESCHEID", "intro"],
      ["Das Bundesvergabeamt hat durch", "intro"],
      ["Spruch", "holding"],
      ["Der Antrag „auf Nichtigerklärung", "holding"],
      ["Begründung", "argumentation"],
      ["Die Ausschreibungsbekanntmachung", "argumentation"],
    ],
  },
  {
    name: "UBAS: a SPRUCH title above the recital",
    fixture: "at-ris-ubas-text.xml",
    caseNumber: "210.910/0/9E-IV/12/99",
    expected: [
      ["BESCHEID", "intro"],
      ["SPRUCH", "intro"],
      ["Der unabhängige Bundesasylsenat hat durch", "intro"],
      ["Der Berufung von Frau V. O.", "holding"],
      ["BEGRÜNDUNG", "argumentation"],
    ],
  },
  {
    name: "BKS: the docket repeated at the head of Text",
    fixture: "at-ris-bks-gesperrt.xml",
    caseNumber: "611.058/001-BKS/2003",
    expected: [
      ["GZ 611.058/001-BKS/2003", "case-number"],
      ["BESCHEID", "intro"],
      ["Der Bundeskommunikationssenat hat durch", "intro"],
      ["Die Berufung wird gemäß § 66 Abs. 4 AVG", "holding"],
      ["Begründung", "argumentation"],
      ["Rechtsmittelbelehrung", "closing"],
    ],
  },
  {
    name: "Umweltsenat: subject line, recital over several lines, annex",
    fixture: "at-ris-umse-abstand.xml",
    caseNumber: "US 4B/2005/1-49",
    expected: [
      ["Betrifft", "intro"],
      ["Genehmigungsbescheid der NÖ Landesregierung", "intro"],
      ["Der Umweltsenat hat durch", "intro"],
      ["Nord“ erteilt wurde, zu Recht erkannt", "intro"],
      ["Die Berufungen nachstehender Berufungswerber", "holding"],
      ["Rechtsmittelbelehrung", "closing"],
      ["Anhänge zu den Auflagen", undefined],
    ],
  },
  {
    name: "VwGH: the bench recital filed under Betreff, place and date",
    fixture: "at-ris-vwgh-text.xml",
    caseNumber: "Ra 2025/07/0312",
    expected: [
      ["Der Verwaltungsgerichtshof hat über den Antrag", "intro"],
      ["Gemäß § 30 Abs. 2 VwGG", "holding"],
      ["7 Dem Antrag war daher", "argumentation"],
      ["Wien, am 2. Jänner 2026", "closing"],
    ],
  },
  {
    name: "OLG: instructions on appeal after the reasons",
    fixture: "at-ris-justiz-text.xml",
    caseNumber: "9Bs136/26b",
    expected: [
      ["Der Beschwerde wird nicht Folge gegeben", "holding"],
      ["BEGRÜNDUNG", "argumentation"],
      ["Rechtsmittelbelehrung", "closing"],
      ["Gegen diese Entscheidung steht", "closing"],
    ],
  },
  {
    name: "OGH: publisher labels that were already right stay",
    fixture: "at-ris-ogh-strafsache.xml",
    caseNumber: "14Os34/12z (14Os39/12k)",
    expected: [
      ["Der Oberste Gerichtshof hat am 12. Juni 2012", "intro"],
      ["I/ Die Wiedereinsetzung wird bewilligt", "holding"],
      ["Gründe", "argumentation"],
    ],
  },
] as const satisfies readonly {
  name: string;
  fixture: string;
  caseNumber: string;
  expected: Expected;
}[];

describe("Austrian decision regions", () => {
  for (const { name, fixture, caseNumber, expected } of RIS_CASES) {
    it(`reads the court's parts, not the publisher's labels: ${name}`, async () => {
      const blocks = await risBlocks(fixture, caseNumber);
      expect<Expected>(rolesOf(blocks, expected)).toEqual(expected);
    });
  }

  it("gives Findok decisions the parts the court printed", async () => {
    const parsed = parseFindokDecisionXml({
      sourceDocumentId: "at-findok-bfg-2026",
      caseNumber: "RV/7500001/2026",
      court: "BFG",
      decisionDate: "2026-07-14",
      decisionType: "Erkenntnis",
      sourceUrl: "https://findok.bmf.gv.at/",
      xml: await fixtureText("at-findok-bfg-2026.xml"),
    }).unwrap();
    const expected = [
      ["Das Bundesfinanzgericht hat über die Beschwerde", "intro"],
      ["I. Die Beschwerde wird als unbegründet abgewiesen", "holding"],
      ["Sachverhalt:", "argumentation"],
      ["Nach § 5 Abs. 2", "argumentation"],
      ["Wien, am 14. Juli 2026", "closing"],
    ] as const satisfies Expected;
    expect<Expected>(rolesOf(parsed.documentAst.blocks, expected)).toEqual(
      expected,
    );
  });
});

it("types the reasons after an Austrian ruling as reasons, not as the tail", async () => {
  const blocks = await risBlocks(
    "at-ris-lvwg-noe.xml",
    "LVwG-AV-2413/001-2023",
  );
  const types = sectionsFromAst(blocks).map((section) => section.type);
  expect(types).toContain("ruling");
  expect(types.slice(types.indexOf("ruling") + 1)).not.toContain("footer");
  expect(types.slice(types.indexOf("ruling") + 1)).toContain("argumentation");
});

type Line = readonly [string, AtCourtTextSection | "heading"];

const read = (lines: readonly Line[], dockets: readonly string[] = []) =>
  readAtDecisionRoles(
    lines.map(([text, section]): AtPrintedLine =>
      section === "heading"
        ? { type: "heading", text }
        : { type: "paragraph", text, section },
    ),
    dockets,
  );

describe("Austrian decision region markers", () => {
  it("never reads a party's sentence as the bench recital", () => {
    expect(
      read([
        [
          "Der Beschwerdeführer hat durch seinen Vertreter vorgebracht:",
          "text",
        ],
        ["Die Behörde habe den Antrag zu Unrecht abgewiesen.", "text"],
      ]),
    ).toEqual(["argumentation", "argumentation"]);
  });

  it("never reads the reviewed authority or the reasons as the recital", () => {
    for (const opening of [
      "Das Rekursgericht hat erwogen:",
      "Die belangte Behörde hat durch Bescheid vom 3. Mai 2020 den Antrag abgewiesen.",
      "Das Finanzamt hat durch Bescheid vom 3. Mai 2020 die Umsatzsteuer festgesetzt.",
    ]) {
      expect(
        read([
          [opening, "text"],
          ["Die Beschwerde ist begründet.", "text"],
        ]),
      ).toEqual(["argumentation", "argumentation"]);
    }
  });

  it("opens the closing only at the last instructions on appeal", () => {
    expect(
      read([
        ["Der Beschwerde wird Folge gegeben.", "operative"],
        ["Begründung:", "text"],
        ["Der Bescheid lautet auszugsweise:", "text"],
        ["Rechtsmittelbelehrung:", "text"],
        ["Gegen diesen Bescheid ist die Berufung zulässig.“", "text"],
        ["Das Verwaltungsgericht hat erwogen:", "text"],
        ["Die Beschwerde ist begründet.", "text"],
        ["Rechtsmittelbelehrung:", "text"],
        ["Gegen dieses Erkenntnis ist die Revision zulässig.", "text"],
      ]),
    ).toEqual([
      "holding",
      "argumentation",
      "argumentation",
      "argumentation",
      "argumentation",
      "argumentation",
      "argumentation",
      "closing",
      "closing",
    ]);
  });

  it("ends a recital at a ruling it announces mid-line", () => {
    expect(
      read([
        [
          "Das Landesverwaltungsgericht Wien erkennt durch seinen Richter Dr. X über die Beschwerde des Y zu Recht: Der Beschwerde wird Folge gegeben.",
          "text",
        ],
        ["Die Revision ist nicht zulässig.", "text"],
        ["Entscheidungsgründe", "text"],
      ]),
    ).toEqual(["intro", "holding", "argumentation"]);
  });

  it("ends a one-line recital at its full stop", () => {
    expect(
      read([
        [
          "Der Unabhängige Verwaltungssenat hat durch sein Mitglied Dr. X über die Berufung entschieden.",
          "operative",
        ],
        ["Der Berufung wird Folge gegeben.", "operative"],
      ]),
    ).toEqual(["intro", "holding"]);
  });

  it("never reads a ruling into a recital that does not end", () => {
    expect(
      read([
        [
          "Das Landesverwaltungsgericht Wien erkennt durch seinen Richter Dr. X über die Beschwerde des Y",
          "text",
        ],
        ["Der Beschwerde wird Folge gegeben.", "text"],
        ["Die Auflage A.1 wird wie folgt abgeändert:", "text"],
        ["Entscheidungsgründe", "text"],
      ]),
    ).toEqual(["intro", "holding", "holding", "argumentation"]);
  });

  it("follows a Spruch label printed as a heading", () => {
    expect(
      read([
        ["BESCHEID", "text"],
        ["Spruch", "heading"],
        ["Der Antrag wird abgewiesen.", "text"],
      ]),
    ).toEqual(["intro", undefined, "holding"]);
    expect(
      read([
        ["Betrifft:", "text"],
        ["Berufung gegen den Bescheid der Landesregierung", "text"],
        ["SPRUCH", "heading"],
        ["Die Berufung wird abgewiesen.", "text"],
      ]),
    ).toEqual(["intro", "intro", undefined, "holding"]);
  });

  it("closes only the place-and-date line of a letter the reasons quote", () => {
    expect(
      read([
        ["Der Beschwerde wird Folge gegeben.", "operative"],
        ["Das Schreiben lautet:", "reasons"],
        ["Wien, am 3. März 2012", "reasons"],
        ["Die Behörde hat darauf nicht reagiert.", "reasons"],
        ["Wien, den 3. März 2020.", "reasons"],
      ]),
    ).toEqual([
      "holding",
      "argumentation",
      "closing",
      "argumentation",
      "closing",
    ]);
  });

  it("reads a place and date at the head as the letterhead", () => {
    expect(
      read([
        ["St. Pölten, am 4. September 2023", "text"],
        [
          "Das Landesverwaltungsgericht Niederösterreich erkennt durch Dr. X als Einzelrichter zu Recht:",
          "text",
        ],
        ["Der Beschwerde wird Folge gegeben.", "text"],
      ]),
    ).toEqual(["intro", "intro", "holding"]);
  });

  it("never moves back to the ruling from the reasons", () => {
    expect(
      read([
        ["Der Beschwerde wird Folge gegeben.", "operative"],
        ["Begründung:", "text"],
        ["Spruch", "text"],
        ["Der Spruch stützt sich auf § 28 VwGVG.", "text"],
      ]),
    ).toEqual(["holding", "argumentation", "argumentation", "argumentation"]);
  });

  it("keeps a Beilage the ruling names inside the ruling", () => {
    expect(
      read([
        [
          "Das Landesverwaltungsgericht Wien erkennt durch Dr. X als Einzelrichter zu Recht:",
          "text",
        ],
        ["I. Die Bewilligung wird erteilt.", "text"],
        ["Beilage:", "text"],
        ["Plan vom 1. Mai 2020", "text"],
        ["Entscheidungsgründe", "text"],
      ]),
    ).toEqual(["intro", "holding", "holding", "holding", "argumentation"]);
  });

  it("keeps an enclosure in the closing, and an annex after it unroled", () => {
    expect(
      read([
        ["Der Beschwerde wird Folge gegeben.", "operative"],
        ["Rechtsmittelbelehrung:", "text"],
        ["Beilage: Erlagschein", "text"],
        ["Wien, am 2. Jänner 2026", "text"],
        ["Anhänge zu den Auflagen:", "text"],
        ["Zur Auflage A.1.1.:", "text"],
      ]),
    ).toEqual([
      "holding",
      "closing",
      "closing",
      "closing",
      undefined,
      undefined,
    ]);
  });

  it("reads only a docket the publisher lists as the docket line", () => {
    expect(
      read(
        [
          ["W224 2231206-1/13E", "operative"],
          ["Geschäftszahl: W224 2231206-1", "operative"],
          ["W224 2231206-10/5E", "operative"],
        ],
        ["W224 2231206-1"],
      ),
    ).toEqual(["case-number", "case-number", "holding"]);
  });
});
