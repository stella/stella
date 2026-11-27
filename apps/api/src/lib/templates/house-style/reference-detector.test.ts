import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { DocxBlockManifest } from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import {
  blockIdOf,
  czechContract,
  czechDecimalContract,
  englishAgreement,
  germanContract,
  heading,
  inColumns,
  manifestOf,
  numbered,
  partsContract,
  provisionKey,
} from "@/api/lib/templates/house-style/manifest.test-helpers";
import { detectReferences } from "@/api/lib/templates/house-style/reference-detector";
import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";

type Read = {
  /** The chain's text. */
  text: string;
  scope: DetectedReference["scope"];
  /** `designator→target` per designator: a provision key when resolved,
   *  `?` when ambiguous, `!reason` when unresolved, `-` when not resolved
   *  because the chain is external. */
  links: string;
};

/** Reads the references of the block that holds `citing`. */
const read = (manifest: DocxBlockManifest, citing: string): Read[] => {
  const index = buildLabelIndex(manifest);
  const blockId = blockIdOf(manifest, citing);
  const text = manifest.blocks.find(({ id }) => id === blockId)?.text ?? "";
  return detectReferences(manifest, index)
    .references.filter((reference) => reference.blockId === blockId)
    .map((reference) => ({
      text: text.slice(reference.start, reference.end),
      scope: reference.scope,
      links: reference.designators
        .map(({ start, end, resolution }) => {
          const designator = text.slice(start, end);
          switch (resolution.status) {
            case "resolved":
              return `${designator}→${provisionKey(index, resolution.targetBlockId)}`;
            case "ambiguous":
              return `${designator}→?`;
            case "unresolved":
              return `${designator}→!${resolution.reason}`;
            case "skipped":
              return `${designator}→-`;
            default: {
              resolution satisfies never;
              return panic("Unhandled resolution");
            }
          }
        })
        .join(" "),
    }));
};

type Expected = readonly [
  text: string,
  scope: DetectedReference["scope"],
  links: string,
];
type Case = readonly [citing: string, ...expected: Expected[]];

const expectCases = (
  build: (citing: string) => DocxBlockManifest,
  cases: readonly Case[],
) => {
  for (const [citing, ...expected] of cases) {
    expect({ citing, found: read(build(citing), citing) }).toEqual({
      citing,
      found: expected.map(([text, scope, links]) => ({ text, scope, links })),
    });
  }
};

describe("Czech internal references", () => {
  test("article references in every case form", () => {
    expectCases(czechContract, [
      ["Plnění dle čl. II této smlouvy.", ["čl. II", "internal", "II→II"]],
      ["Plnění dle čl. II. této smlouvy.", ["čl. II", "internal", "II→II"]],
      [
        "Plnění dle čl.\u00A0II této smlouvy.",
        ["čl.\u00A0II", "internal", "II→II"],
      ],
      ["Plnění dle čl.II této smlouvy.", ["čl.II", "internal", "II→II"]],
      [
        "Podle článku XIV. této smlouvy.",
        ["článku XIV", "internal", "XIV→XIV"],
      ],
      ["V souladu s článkem III.", ["článkem III", "internal", "III→III"]],
      [
        "Jak stanoví Článek VII smlouvy.",
        ["Článek VII", "internal", "VII→VII"],
      ],
      [
        "Sankce v článcích XI a XII.",
        ["článcích XI a XII", "internal", "XI→XI XII→XII"],
      ],
      ["Dle čl. II Smlouvy platí.", ["čl. II", "internal", "II→II"]],
    ]);
  });

  test("an article with its paragraph, letter and point", () => {
    expectCases(czechContract, [
      [
        "Cena dle čl. IV. odst. 1 této smlouvy.",
        ["čl. IV. odst. 1", "internal", "IV→IV 1→IV/1"],
      ],
      [
        "Cena dle článku IV odstavce 3 této smlouvy.",
        ["článku IV odstavce 3", "internal", "IV→IV 3→IV/3"],
      ],
      [
        "Pokuta dle čl. XI odst. 2 písm. b) této smlouvy.",
        ["čl. XI odst. 2 písm. b)", "internal", "XI→XI 2→XI/2 b)→XI/2/b"],
      ],
      [
        "Pokuta dle čl. XI odst. 2 písmene b) této smlouvy.",
        ["čl. XI odst. 2 písmene b)", "internal", "XI→XI 2→XI/2 b)→XI/2/b"],
      ],
      [
        "Pokuta dle čl. XI odst. 2 písm. d) bodu (ii) této smlouvy.",
        [
          "čl. XI odst. 2 písm. d) bodu (ii)",
          "internal",
          "XI→XI 2→XI/2 d)→XI/2/d (ii)→XI/2/d/ii",
        ],
      ],
      [
        "Pokuta dle čl. XI, odst. 3 této smlouvy.",
        ["čl. XI, odst. 3", "internal", "XI→XI 3→XI/3"],
      ],
    ]);
  });

  test("combined chains keep one link per designator", () => {
    expectCases(czechContract, [
      [
        "Sankce dle čl. XI. odst. 1 a odst. 2 písm. d) této smlouvy.",
        [
          "čl. XI. odst. 1 a odst. 2 písm. d)",
          "internal",
          "XI→XI 1→XI/1 2→XI/2 d)→XI/2/d",
        ],
      ],
      [
        "Povinnosti dle čl. IX. nebo X. této smlouvy.",
        ["čl. IX. nebo X", "internal", "IX→IX X→X"],
      ],
      [
        "Dle čl. I, II a III této smlouvy.",
        ["čl. I, II a III", "internal", "I→I II→II III→III"],
      ],
      [
        "Dle čl. II odst. 1 a 3 této smlouvy.",
        ["čl. II odst. 1 a 3", "internal", "II→II 1→II/1 3→II/3"],
      ],
      [
        "Dle čl. XI odst. 2 písm. a), b) a e) této smlouvy.",
        [
          "čl. XI odst. 2 písm. a), b) a e)",
          "internal",
          "XI→XI 2→XI/2 a)→XI/2/a b)→XI/2/b e)→XI/2/e",
        ],
      ],
      [
        "Dle čl. II odst. 2 a čl. III odst. 1 této smlouvy.",
        [
          "čl. II odst. 2 a čl. III odst. 1",
          "internal",
          "II→II 2→II/2 III→III 1→III/1",
        ],
      ],
      [
        "Dle čl. II odst. 2, čl. III odst. 1 a čl. IV této smlouvy.",
        [
          "čl. II odst. 2, čl. III odst. 1 a čl. IV",
          "internal",
          "II→II 2→II/2 III→III 1→III/1 IV→IV",
        ],
      ],
    ]);
  });

  test("ranges link both ends", () => {
    expectCases(czechContract, [
      [
        "Dle čl. II až IV této smlouvy.",
        ["čl. II až IV", "internal", "II→II IV→IV"],
      ],
      ["Dle čl. II–IV této smlouvy.", ["čl. II–IV", "internal", "II→II IV→IV"]],
      [
        "Dle čl. XI odst. 2 písm. a) až c) této smlouvy.",
        [
          "čl. XI odst. 2 písm. a) až c)",
          "internal",
          "XI→XI 2→XI/2 a)→XI/2/a c)→XI/2/c",
        ],
      ],
    ]);
    const { references } = detectReferences(
      czechContract("Dle čl. II až IV této smlouvy."),
    );
    expect(references.at(0)?.designators.map(({ join }) => join)).toEqual([
      null,
      "range",
    ]);
  });

  test("relative forms resolve inside the citing article", () => {
    expectCases(czechContract, [
      ["Osoby dle odst. 1 tohoto článku.", ["odst. 1", "internal", "1→V/1"]],
      [
        "Cena dle odstavce 3 tohoto článku smlouvy.",
        ["odstavce 3", "internal", "3→V/3"],
      ],
      ["Jak uvádí odst. 3.", ["odst. 3", "internal", "3→V/3"]],
      [
        "Jak uvádí odstavec 1 a 3.",
        ["odstavec 1 a 3", "internal", "1→V/1 3→V/3"],
      ],
      ["Podle bodu 3 tohoto článku.", ["bodu 3", "internal", "3→V/3"]],
    ]);
    const confidences = (citing: string) =>
      detectReferences(czechContract(citing))
        .references.flatMap(({ designators }) => designators)
        .map(({ resolution }) =>
          resolution.status === "resolved" ? resolution.confidence : null,
        );
    expect(confidences("Jak uvádí odst. 3.")).toEqual([0.75]);
    expect(confidences("Osoby dle odst. 3 tohoto článku.")).toEqual([0.92]);
  });

  test("a letter said inside a list means that list", () => {
    const manifest = manifestOf([
      "Článek I.\nSankce",
      numbered("1.", "Dodavatel zaplatí pokutu:", 1),
      numbered("a)", "za prodlení;", 2),
      numbered("b)", "za vady, nejde-li o případ dle písm. a);", 2),
      numbered("2.", "Pokuta dle odst. 1 písm. b) je splatná ihned.", 1),
    ]);
    expect(read(manifest, "za vady")).toEqual([
      { text: "písm. a)", scope: "internal", links: "a)→I/1/a" },
    ]);
    expect(read(manifest, "Pokuta dle")).toEqual([
      { text: "odst. 1 písm. b)", scope: "internal", links: "1→I/1 b)→I/1/b" },
    ]);
  });

  test("each coordinated part takes the article named after it", () => {
    expectCases(czechContract, [
      [
        "Podle odst. 1 čl. II a odst. 2 čl. III této smlouvy.",
        [
          "odst. 1 čl. II a odst. 2 čl. III",
          "internal",
          "1→II/1 II→II 2→III/2 III→III",
        ],
      ],
      [
        "Podle odst. 1 čl. II a odst. 2 této smlouvy.",
        ["odst. 1 čl. II a odst. 2", "internal", "1→II/1 II→II 2→II/2"],
      ],
      [
        "Podle odst. 1 čl. II, odst. 2 čl. III a odst. 3 čl. IV této smlouvy.",
        [
          "odst. 1 čl. II, odst. 2 čl. III a odst. 3 čl. IV",
          "internal",
          "1→II/1 II→II 2→III/2 III→III 3→IV/3 IV→IV",
        ],
      ],
    ]);
  });

  test("a dotted paragraph number reads two ways until the text says which", () => {
    const build = (citing: string) =>
      manifestOf([
        "Článek I.\nPrvní",
        numbered("1.", "Text.", 1),
        "Článek II.\nDruhý",
        numbered("1.", "Text.", 2),
        numbered("2.", "Text.", 2),
        "Článek III.\nTřetí",
        numbered("1.", "Text.", 3),
        numbered("2.", "Odstavec:", 3),
        numbered("2.1", "Pododstavec.", 3),
        numbered("3.", citing, 3),
      ]);
    expectCases(build, [
      [
        "Podle odst. 2.1 tohoto článku.",
        ["odst. 2.1", "internal", "2.1→III/2.1"],
      ],
      ["Podle odst. 2.1.", ["odst. 2.1", "internal", "2.1→?"]],
      ["Podle odst. 1.1.", ["odst. 1.1", "internal", "1.1→I/1"]],
      [
        "Podle čl. II odst. 1 této smlouvy.",
        ["čl. II odst. 1", "internal", "II→II 1→II/1"],
      ],
    ]);
  });

  test("the wider provision may follow the narrower one", () => {
    expectCases(czechContract, [
      [
        "Podle odst. 2 čl. VII této smlouvy.",
        ["odst. 2 čl. VII", "internal", "2→VII/2 VII→VII"],
      ],
      [
        "Podle odstavců 1 a 2 článku VII této smlouvy.",
        ["odstavců 1 a 2 článku VII", "internal", "1→VII/1 2→VII/2 VII→VII"],
      ],
      [
        "Podle písm. a) odst. 2 čl. XI této smlouvy.",
        ["písm. a) odst. 2 čl. XI", "internal", "a)→XI/2/a 2→XI/2 XI→XI"],
      ],
    ]);
  });

  test("a decimal scheme with dotted paragraphs", () => {
    expectCases(czechDecimalContract, [
      ["Dle čl. 3 až 5 této dohody.", ["čl. 3 až 5", "internal", "3→3 5→5"]],
      ["Dle čl. 5 této dohody.", ["čl. 5", "internal", "5→5"]],
      ["Dle odst. 5.2 této dohody.", ["odst. 5.2", "internal", "5.2→5/2"]],
      ["Dle čl. 5.2 této dohody.", ["čl. 5.2", "internal", "5.2→5/2"]],
      ["Dle bodu 5.2.", ["bodu 5.2", "unknown", "5.2→5/2"]],
      [
        "Dle čl. 5 odst. 5.2, čl. 6 odst. 6.3 této dohody.",
        [
          "čl. 5 odst. 5.2, čl. 6 odst. 6.3",
          "internal",
          "5→5 5.2→5/2 6→6 6.3→6/3",
        ],
      ],
      [
        "Dle odst. 2.1 a 2.3.",
        ["odst. 2.1 a 2.3", "internal", "2.1→2/1 2.3→2/3"],
      ],
    ]);
  });

  test("annexes resolve to the heading, not to the list of annexes", () => {
    expectCases(czechContract, [
      [
        "Specifikace tvoří Přílohu č. 1 této smlouvy.",
        ["Přílohu č. 1", "internal", "1→annex 1"],
      ],
      ["Ceny uvádí příloha č. 2.", ["příloha č. 2", "internal", "2→annex 2"]],
      [
        "V přílohách č. 1 a 2 této smlouvy.",
        ["přílohách č. 1 a 2", "internal", "1→annex 1 2→annex 2"],
      ],
      [
        "Podle bodu 2 Přílohy č. 1 této smlouvy.",
        ["bodu 2 Přílohy č. 1", "internal", "2→!withinAnnex 1→annex 1"],
      ],
      [
        "Podle Přílohy č. 1 bodu 2 této smlouvy.",
        ["Přílohy č. 1 bodu 2", "internal", "1→annex 1 2→!withinAnnex"],
      ],
      [
        "Podle čl. V. Přílohy č. 1 této smlouvy.",
        ["čl. V. Přílohy č. 1", "internal", "V→!withinAnnex 1→annex 1"],
      ],
    ]);
  });

  test("a reference to a provision the document lacks stays unresolved", () => {
    expectCases(czechContract, [
      ["Dle čl. XX této smlouvy.", ["čl. XX", "internal", "XX→!missingTarget"]],
      [
        "Dle čl. II odst. 9 této smlouvy.",
        ["čl. II odst. 9", "internal", "II→II 9→!missingTarget"],
      ],
      ["Dle čl. XX.", ["čl. XX", "unknown", "XX→!missingTarget"]],
      [
        "Dle čl. II odst. 1 a 9 této smlouvy.",
        ["čl. II odst. 1 a 9", "internal", "II→II 1→II/1 9→!missingTarget"],
      ],
      ["Viz Přílohu F.", ["Přílohu F", "unknown", "F→!missingTarget"]],
    ]);
  });
});

describe("Czech text that is not an internal reference", () => {
  test("legislation stays external", () => {
    expectCases(czechContract, [
      [
        "Ve smyslu § 109 odst. 2 písm. b) ZDPH ručí.",
        ["§ 109 odst. 2 písm. b)", "external", "109→- 2→- b)→-"],
      ],
      [
        "Podle § 2586 a násl. zákona č. 89/2012 Sb., občanský zákoník.",
        ["§ 2586", "external", "2586→-"],
      ],
      [
        "Práva dle § 1765 odst. 1 a § 2620 odst. 2 občanského zákoníku.",
        [
          "§ 1765 odst. 1 a § 2620 odst. 2",
          "external",
          "1765→- 1→- 2620→- 2→-",
        ],
      ],
      ["Plátce dle § 106a ZDPH.", ["§ 106a", "external", "106a→-"]],
      ["Dle § 2591 nelze postupovat.", ["§ 2591", "external", "2591→-"]],
      ["Zpracování dle čl. 5 Nařízení.", ["čl. 5", "external", "5→-"]],
      [
        "Dle čl. 6 odst. 1 písm. b) GDPR.",
        ["čl. 6 odst. 1 písm. b)", "external", "6→- 1→- b)→-"],
      ],
      [
        "Dle čl. 28 obecného nařízení o ochraně osobních údajů.",
        ["čl. 28", "external", "28→-"],
      ],
      [
        "Dle čl. 101 Smlouvy o fungování Evropské unie.",
        ["čl. 101", "external", "101→-"],
      ],
      [
        "Dle § 2 písm. e) zákona č. 320/2001 Sb.",
        ["§ 2 písm. e)", "external", "2→- e)→-"],
      ],
      [
        "Dle § 5 odst. 2 věta první autorského zákona.",
        ["§ 5 odst. 2", "external", "5→- 2→-"],
      ],
      ["Dle čl. II tohoto zákona.", ["čl. II", "external", "II→-"]],
    ]);
  });

  test("other documents stay external or go to the model", () => {
    expectCases(czechContract, [
      ["Dle čl. 3 VOP.", ["čl. 3", "external", "3→-"]],
      ["Dle čl. XX Rámcové smlouvy.", ["čl. XX", "external", "XX→-"]],
      ["Dle čl. II Rámcové smlouvy.", ["čl. II", "unknown", "II→II"]],
      ["Dle čl. II kupní smlouvy.", ["čl. II", "unknown", "II→II"]],
      ["Dle čl. 40 Stanov.", ["čl. 40", "external", "40→-"]],
      ["Viz Přílohu F zadávací dokumentace.", ["Přílohu F", "external", "F→-"]],
    ]);
    const { ambiguities, references } = detectReferences(
      czechContract("Dle čl. II Rámcové smlouvy."),
    );
    expect(ambiguities).toEqual([
      {
        kind: "scope",
        referenceId: references.at(0)?.id ?? "",
        options: ["internal", "external"],
      },
    ]);
  });

  test("numbers that count something else are not designators", () => {
    expectCases(czechContract, [
      ["Dle čl. II a 10 dnů předem.", ["čl. II", "internal", "II→II"]],
      ["Dle odst. 1 a 30 % ceny.", ["odst. 1", "internal", "1→V/1"]],
      ["Dle odst. 1 a 2 000 Kč.", ["odst. 1", "internal", "1→V/1"]],
      ["Dle odst. 1 a 14 kusů.", ["odst. 1", "internal", "1→V/1"]],
      ["Zákon č. 89/2012 Sb. a faktura č. 2024001."],
      ["Smlouva a její příloha a dodatky."],
      ["Jak je uvedeno v tomto článku a v předchozím bodu."],
      ["Včetně všech jejích příloh a součástí."],
    ]);
  });

  test("a mistyped head is a question for the model, never a link", () => {
    const manifest = czechContract("Důvěrné dle č. VIII této smlouvy.");
    expect(read(manifest, "Důvěrné")).toEqual([
      { text: "č. VIII", scope: "unknown", links: "VIII→VIII" },
    ]);
    const { references, ambiguities } = detectReferences(manifest);
    expect(references.at(0)?.evidence).toContain("looseHead");
    expect(ambiguities.map(({ kind }) => kind)).toEqual(["scope"]);
    expectCases(czechContract, [
      ["Dodatek č. 2 této smlouvy."],
      ["Objednávka č. VIII ze dne 1. 1. 2024."],
    ]);
  });

  test("headings and the list of annexes cite nothing", () => {
    const manifest = czechContract("Bez odkazu.");
    const index = buildLabelIndex(manifest);
    const cited = new Set(
      detectReferences(manifest, index).references.map(
        ({ blockId }) => blockId,
      ),
    );
    const typed = index.entries
      .filter(({ origin }) => origin === "manual")
      .map(({ blockId }) => blockId);
    expect(typed.length).toBeGreaterThan(14);
    expect(typed.filter((blockId) => cited.has(blockId))).toEqual([]);
  });
});

describe("English references", () => {
  test("internal chains", () => {
    expectCases(englishAgreement, [
      [
        "As set out in Section 2.3(b).",
        ["Section 2.3(b)", "internal", "2.3→2/3 (b)→2/3/b"],
      ],
      [
        "As set out in Clause 2.3(b)(ii).",
        ["Clause 2.3(b)(ii)", "internal", "2.3→2/3 (b)→2/3/b (ii)→2/3/b/ii"],
      ],
      ["Subject to Article 3.", ["Article 3", "internal", "3→3"]],
      [
        "Subject to Articles 3 to 5.",
        ["Articles 3 to 5", "internal", "3→3 5→5"],
      ],
      [
        "Subject to Clauses 2.1, 2.2 and 2.3.",
        ["Clauses 2.1, 2.2 and 2.3", "internal", "2.1→2/1 2.2→2/2 2.3→2/3"],
      ],
      [
        "Subject to Clause 5.1 of this Agreement.",
        ["Clause 5.1", "internal", "5.1→5/1"],
      ],
      ["Subject to clause 4.1 hereof.", ["clause 4.1", "internal", "4.1→4/1"]],
      ["Subject to sub-clause 2.3.", ["sub-clause 2.3", "internal", "2.3→2/3"]],
      [
        "Subject to paragraph (b) of Clause 2.3.",
        ["paragraph (b) of Clause 2.3", "internal", "(b)→2/3/b 2.3→2/3"],
      ],
      [
        "Subject to Clauses 2.3(a) and 5.2.",
        ["Clauses 2.3(a) and 5.2", "internal", "2.3→2/3 (a)→2/3/a 5.2→5/2"],
      ],
      [
        "Subject to Clause 3 of the Agreement.",
        ["Clause 3", "internal", "3→3"],
      ],
      ["As described in Annex 1.", ["Annex 1", "internal", "1→annex 1"]],
      [
        "As described in Annexes 1 and 2 to this Agreement.",
        ["Annexes 1 and 2", "internal", "1→annex 1 2→annex 2"],
      ],
      [
        "As stated in Recital (B).",
        ["Recital (B)", "internal", "(B)→recital b"],
      ],
      [
        "See paragraph 1 of Annex 1.",
        ["paragraph 1 of Annex 1", "internal", "1→!withinAnnex 1→annex 1"],
      ],
    ]);
  });

  test("articles numbered under a part in roman numerals", () => {
    expectCases(partsContract, [
      [
        "As set out in Article II.2.1.",
        ["Article II.2.1", "internal", "II.2.1→II/2.1"],
      ],
      [
        "The obligations in Articles I.2.2 and II.1 apply.",
        ["Articles I.2.2 and II.1", "internal", "I.2.2→I/2.2 II.1→II/1"],
      ],
      [
        "In accordance with Article I.2.",
        ["Article I.2", "internal", "I.2→I/2"],
      ],
      [
        "Under Article II of this contract.",
        ["Article II", "internal", "II→II"],
      ],
      [
        "Under Article II.9.",
        ["Article II.9", "unknown", "II.9→!missingTarget"],
      ],
    ]);
  });

  test("a sentence that ends after the designator does not lend its opening", () => {
    expectCases(englishAgreement, [
      [
        "See Article 1. Article 2 of the Companies Act applies.",
        ["Article 1", "internal", "1→1"],
        ["Article 2", "external", "2→-"],
      ],
      [
        "As set out in Clause 4.1. The Supplier shall comply.",
        ["Clause 4.1", "internal", "4.1→4/1"],
      ],
      [
        "As set out in Clause 4.1. VAT is payable in addition.",
        ["Clause 4.1", "internal", "4.1→4/1"],
      ],
    ]);
  });

  test("legislation and other documents", () => {
    expectCases(englishAgreement, [
      [
        "Under Section 5 of the Companies Act 2006.",
        ["Section 5", "external", "5→-"],
      ],
      [
        "Under Article 6(1)(b) GDPR.",
        ["Article 6(1)(b)", "external", "6→- (1)→- (b)→-"],
      ],
      ["Under Article 101 TFEU.", ["Article 101", "external", "101→-"]],
      ["Under Article 5 of the SHA.", ["Article 5", "external", "5→-"]],
      ["Under Section 3 of this Act.", ["Section 3", "external", "3→-"]],
      [
        "Under Clause 3 of the Lease Agreement.",
        ["Clause 3", "unknown", "3→3"],
      ],
      [
        "Under Clause 12 of the Lease Agreement.",
        ["Clause 12", "external", "12→-"],
      ],
      ["Under Section 9.9.", ["Section 9.9", "unknown", "9.9→!missingTarget"]],
    ]);
  });

  test("prose that only looks like a reference", () => {
    expectCases(englishAgreement, [
      ["Within 5 days of this clause taking effect."],
      ["Each section and article of the handbook."],
      ["A schedule a week is enough."],
      ["Raised as item 3.", ["item 3", "unknown", "3→4/3"]],
    ]);
  });
});

describe("German references", () => {
  test("the section sign heads the contract's own provisions", () => {
    expectCases(germanContract, [
      ["Gemäß § 5 dieses Vertrages.", ["§ 5", "internal", "5→5"]],
      [
        "Gemäß § 5 Abs. 2 dieses Vertrags.",
        ["§ 5 Abs. 2", "internal", "5→5 2→5/2"],
      ],
      ["Gemäß § 5 Absatz 2.", ["§ 5 Absatz 2", "internal", "5→5 2→5/2"]],
      [
        "Gemäß § 3 Abs. 1 lit. a) dieses Vertrages.",
        ["§ 3 Abs. 1 lit. a)", "internal", "3→3 1→3/1 a)→3/1/a"],
      ],
      [
        "Gemäß § 3 Abs. 2 Satz 1 dieses Vertrages.",
        ["§ 3 Abs. 2", "internal", "3→3 2→3/2"],
      ],
      ["Gemäß §§ 2 bis 4.", ["§§ 2 bis 4", "internal", "2→2 4→4"]],
      ["Gemäß § 2 und § 3.", ["§ 2 und § 3", "internal", "2→2 3→3"]],
      ["Gemäß Abs. 1 dieses Paragraphen.", ["Abs. 1", "internal", "1→4/1"]],
      ["Gemäß Abs. 3.", ["Abs. 3", "internal", "3→4/3"]],
      ["Siehe Anlage 1.", ["Anlage 1", "internal", "1→annex 1"]],
    ]);
  });

  test("statutes and other documents", () => {
    expectCases(germanContract, [
      ["Nach § 433 Abs. 2 BGB.", ["§ 433 Abs. 2", "external", "433→- 2→-"]],
      ["Nach § 5 Abs. 1 Nr. 3 UStG.", ["§ 5 Abs. 1", "external", "5→- 1→-"]],
      [
        "Nach Art. 6 Abs. 1 lit. b DSGVO.",
        ["Art. 6 Abs. 1 lit. b", "external", "6→- 1→- b→-"],
      ],
      ["Nach § 2 des Bürgerlichen Gesetzbuchs.", ["§ 2", "external", "2→-"]],
      ["Nach § 15 GmbHG.", ["§ 15", "external", "15→-"]],
      ["Nach § 3 der AGB.", ["§ 3", "external", "3→-"]],
      ["Nach § 15 des Gesellschaftsvertrages.", ["§ 15", "external", "15→-"]],
      ["Nach § 2 des Kaufvertrages.", ["§ 2", "unknown", "2→2"]],
      ["Nach § 2 des Vertrages.", ["§ 2", "internal", "2→2"]],
      ["Nach § 99.", ["§ 99", "unknown", "99→!missingTarget"]],
    ]);
  });

  test("dotted numbering under Ziffer", () => {
    expectCases(englishAgreement, [
      [
        "Gemäß Ziffer 2.3 dieses Vertrages.",
        ["Ziffer 2.3", "internal", "2.3→2/3"],
      ],
      ["Gemäß Ziff. 5.1.", ["Ziff. 5.1", "internal", "5.1→5/1"]],
    ]);
  });
});

describe("parallel columns", () => {
  const bilingual = inColumns(2, [
    "Článek I.\nPředmět",
    "Article I\nSubject",
    numbered("1.", "Dodavatel dodá zboží.", 1),
    numbered("1.", "The supplier delivers the goods.", 2),
    "Článek II.\nCena",
    "Article II\nPrice",
    numbered("1.", "Cena za plnění dle čl. I odst. 1 této smlouvy.", 3),
    numbered("1.", "The price of the delivery under Article I paragraph 1.", 4),
    numbered("2.", "Viz odst. 1 tohoto článku.", 3),
    numbered("2.", "See paragraph 1 of this Article.", 4),
  ]);

  test("each column is indexed as a text of its own", () => {
    const index = buildLabelIndex(bilingual);
    expect(
      index.entries.map(({ blockId, column }) => [blockId, column]),
    ).toEqual([
      ["p0", 0],
      ["p1", 1],
      ["p2", 0],
      ["p3", 1],
      ["p4", 0],
      ["p5", 1],
      ["p6", 0],
      ["p7", 1],
      ["p8", 0],
      ["p9", 1],
    ]);
    expect(index.entryByBlockId.get("p7")).toMatchObject({
      articleBlockId: "p5",
      parentBlockId: "p5",
    });
  });

  test("a reference resolves within its own column", () => {
    const targets = (start: string) => {
      const blockId = blockIdOf(bilingual, start);
      return detectReferences(bilingual)
        .references.filter((reference) => reference.blockId === blockId)
        .flatMap(({ designators }) => designators)
        .map(({ resolution }) =>
          resolution.status === "resolved" ? resolution.targetBlockId : null,
        );
    };
    expect(targets("Cena za plnění")).toEqual(["p0", "p2"]);
    expect(targets("The price of")).toEqual(["p1", "p3"]);
    expect(targets("Viz odst.")).toEqual(["p6"]);
    expect(targets("See paragraph")).toEqual(["p7"]);
  });

  test("a heading that spans the columns heads the provisions of each", () => {
    const body = inColumns(2, [
      numbered("1.", "Každý partner plní své povinnosti.", 1),
      numbered("1.", "Jede Partnerin erfüllt ihre Pflichten.", 2),
      numbered("2.", "Vedle povinností dle odst. 1 vede partner evidenci.", 1),
      numbered("2.", "Neben den Pflichten nach Abs. 1 führt sie Buch.", 2),
    ]);
    const [table, ...cells] = body.blocks;
    const spanning = manifestOf(["§ 3\nPovinnosti / Verpflichtungen"]).blocks;
    const manifest = {
      ...body,
      blocks: [
        ...spanning.map((block) => ({ ...block, id: "h0" })),
        ...(table === undefined ? [] : [table]),
        ...cells,
      ],
    };
    const index = buildLabelIndex(manifest);
    expect(index.entryByBlockId.get("p3")).toMatchObject({
      level: "clause",
      articleBlockId: "h0",
      column: 1,
    });
    const targetsOf = (blockId: string) =>
      detectReferences(manifest, index)
        .references.filter((reference) => reference.blockId === blockId)
        .flatMap(({ designators }) => designators)
        .map(({ resolution }) =>
          resolution.status === "resolved" ? resolution.targetBlockId : null,
        );
    expect(targetsOf("p2")).toEqual(["p0"]);
    expect(targetsOf("p3")).toEqual(["p1"]);
  });

  test("a table that does not repeat the articles stays in the main story", () => {
    const manifest = inColumns(2, [
      "Článek I.\nCeny",
      "Položka",
      numbered("1.", "Ceny uvádí tabulka.", 1),
      "Cena",
    ]);
    expect([...buildLabelIndex(manifest).columnByBlockId]).toEqual([]);
  });
});

describe("ambiguity", () => {
  test("a designator the document carries twice is offered, not chosen", () => {
    const manifest = manifestOf([
      "Článek I.\nPrvní",
      numbered("1.", "Text.", 1),
      "Článek II.\nDruhý",
      numbered("1.", "Viz čl. III této smlouvy.", 2),
      "Článek III.\nTřetí",
      numbered("1.", "Text.", 3),
      "Článek III.\nTřetí podruhé",
      numbered("1.", "Text.", 4),
    ]);
    const { references, ambiguities } = detectReferences(manifest);
    expect(references).toHaveLength(1);
    expect(ambiguities).toEqual([
      {
        kind: "target",
        referenceId: references.at(0)?.id ?? "",
        designatorIndex: 0,
        candidates: [
          { targetBlockId: "p4", confidence: 0.45 },
          { targetBlockId: "p6", confidence: 0.45 },
        ],
      },
    ]);
  });

  test("a typed line naming a numbered article is read as a reference to it", () => {
    const manifest = manifestOf([
      { ...heading("Definitions"), label: "1." },
      numbered("1.1", "Clause."),
      { ...heading("Data Protection"), label: "2." },
      numbered("2.1", "The following survive termination:"),
      "Clause 2 Data Protection",
    ]);
    expect(read(manifest, "Clause 2 Data")).toEqual([
      { text: "Clause 2", scope: "internal", links: "2→2" },
    ]);
  });

  test("lines of a table of contents are not second headings", () => {
    const manifest = manifestOf([
      { text: "Článek I. První\t2", styleName: "toc 1" },
      "Článek II. Druhý\t3",
      "Článek I.\nPrvní",
      numbered("1.", "Viz čl. II této smlouvy.", 1),
      "Článek II.\nDruhý",
      numbered("1.", "Text.", 2),
    ]);
    expect(read(manifest, "Viz")).toEqual([
      { text: "čl. II", scope: "internal", links: "II→II" },
    ]);
    expect(detectReferences(manifest).references).toHaveLength(1);
  });

  test("a numeral written differently from its heading resolves with less confidence", () => {
    const { references } = detectReferences(
      czechContract("Dle čl. 11 této smlouvy."),
    );
    expect(
      references
        .at(0)
        ?.designators.map(({ resolution }) =>
          resolution.status === "resolved" ? resolution.confidence : null,
        ),
    ).toEqual([0.6]);
  });
});

describe("references the source holds as fields", () => {
  /** The manifest of `citing` with a source field over `shown` that points
   *  at the paragraph holding `target`. */
  const withField = (
    citing: string,
    shown: string,
    target: string,
  ): DocxBlockManifest => {
    const manifest = englishAgreement(citing);
    const block = manifest.blocks.find(({ text }) => text.includes(citing));
    if (block === undefined) {
      return panic("the citing paragraph is missing");
    }
    const start = block.text.indexOf(shown);
    block.crossReferences = [
      {
        start,
        end: start + shown.length,
        instruction: String.raw` REF _Ref1 \r \h `,
        bookmark: "_Ref1",
        targetBlockId: blockIdOf(manifest, target),
        targetWhole: true,
      },
    ];
    return manifest;
  };

  test("a bare number the drafter linked is a citation of the field's target", () => {
    const citing = "The rules of 3.2 apply to it.";
    expect(read(withField(citing, "3.2", "Wording 3.2:"), citing)).toEqual([
      { text: "3.2", scope: "internal", links: "3.2→3/2" },
    ]);
    // Without the field the number is no citation.
    expect(read(englishAgreement(citing), citing)).toEqual([]);
  });

  test("a chain read over the field is not read twice", () => {
    const citing = "See Clause 3.2 for the charges.";
    expect(read(withField(citing, "3.2", "Wording 3.2:"), citing)).toEqual(
      read(englishAgreement(citing), citing),
    );
  });
});

describe("a chain read as another document's that the drafter linked here", () => {
  test("takes the field's target and reads as internal", () => {
    const citing = "As in Section 3.2 of the Companies Act 2006.";
    const manifest = englishAgreement(citing);
    const unlinked = read(manifest, citing);
    expect(unlinked.map(({ scope }) => scope)).toEqual(["external"]);
    const block = manifest.blocks.find(({ text }) => text.includes(citing));
    const start = citing.indexOf("3.2");
    if (block === undefined) {
      return panic("the citing paragraph is missing");
    }
    block.crossReferences = [
      {
        start: block.text.indexOf(citing) + start,
        end: block.text.indexOf(citing) + start + 3,
        instruction: String.raw` REF _Ref1 \w \h `,
        bookmark: "_Ref1",
        targetBlockId: blockIdOf(manifest, "Wording 3.2:"),
        targetWhole: true,
      },
    ];
    expect(read(manifest, citing)).toEqual([
      { text: unlinked[0]?.text ?? "", scope: "internal", links: "3.2→3/2" },
    ]);
  });
});
