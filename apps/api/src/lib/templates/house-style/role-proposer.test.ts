import { describe, expect, test } from "bun:test";

import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/templates/house-style/folio-contract";
import {
  blockIdOf,
  czechContract,
  czechDecimalContract,
  englishAgreement,
  heading,
  inColumns,
  manifestOf,
  numbered,
} from "@/api/lib/templates/house-style/manifest.test-helpers";
import { proposeBlockRoles } from "@/api/lib/templates/house-style/role-proposer";
import type { HouseStyleRole } from "@/api/lib/templates/house-style/role-proposer";

const rolesOf = (
  manifest: DocxBlockManifest,
): Record<string, HouseStyleRole> => {
  const proposals = proposeBlockRoles({ manifest });
  const textById = new Map(manifest.blocks.map(({ id, text }) => [id, text]));
  return Object.fromEntries(
    proposals.map(({ blockId, role }) => [
      (textById.get(blockId) ?? "").split("\n").join(" ").slice(0, 28),
      role,
    ]),
  );
};

describe("proposeBlockRoles", () => {
  test("heads the parts of a pack, whatever their words", () => {
    const part = (label: string, text: string) => ({
      ...heading(text),
      label,
      numId: 5,
    });
    const article = (label: string, text: string) => ({
      text,
      label,
      styleName: "Level 1",
      outlineLevel: 1,
    });
    const manifest = manifestOf([
      part("III.", "Order Form"),
      "The Buyer orders the Deliverables.",
      part("IV.", "Short form Terms"),
      article("1", "Definitions"),
      numbered("1.1", "Terms have the meaning given."),
      article("4", "The Supplier's obligations"),
      numbered("4.1", "The Supplier must deliver."),
      part("VI.", "[Annex – Specification] (Optional)"),
    ]);
    expect(rolesOf(manifest)).toMatchObject({
      "Order Form": "heading",
      "Short form Terms": "heading",
      Definitions: "articleHeading",
      "[Annex – Specification] (Opt": "heading",
    });
  });

  test("reads the parts of a Czech contract", () => {
    const manifest = czechContract("Viz čl. II této smlouvy.");
    expect(rolesOf(manifest)).toMatchObject({
      "SMLOUVA O DODÁVCE": "title",
      "Dodavatel: Horák Stavby s.r.": "party",
      "(dále jen „dodavatel“)": "party",
      // The word between two parties is text of the page.
      a: "body",
      "uzavírají tuto smlouvu:": "recital",
      "Článek I.": "articleHeading",
      "Úvodní ustanovení": "articleHeading",
      "Článek II. Předmět plnění": "articleHeading",
      "První ujednání, oddíl II.": "clause1",
      "první případ;": "letter",
      "první podbod,": "roman",
      "Nedílnou součástí této smlou": "clause1",
      "Příloha č. 1 – Specifikace": "annexList",
      "V Praze dne ……………": "signature",
      "Za dodavatele": "signature",
      "Příloha č. 1": "annexHeading",
      "Příloha č. 2 Ceník": "annexHeading",
      "Ceny jsou uvedeny bez daně.": "body",
    });
  });

  test("a list level that prints nothing is no label", () => {
    // A heading style bound to a list for its outline only: the level
    // prints nothing, the label is typed.
    const silent = (text: string) => ({
      text,
      label: "",
      numId: 7,
      styleName: "heading 3",
      outlineLevel: 2,
    });
    const manifest = manifestOf([
      "SMLOUVA O DÍLO",
      "Čl. 1",
      "Předmět smlouvy",
      numbered("1.", "Zhotovitel provede dílo.", 3),
      silent(""),
      silent("Čl. 2"),
      silent("Účel smlouvy"),
      numbered("1.", "Účelem smlouvy je úprava práv.", 3),
    ]);
    const proposals = proposeBlockRoles({ manifest });
    const proposalOf = (id: string) =>
      proposals.find(({ blockId }) => blockId === id);
    expect(proposalOf("p4")).toBeUndefined();
    expect(proposalOf("p5")).toMatchObject({
      role: "articleHeading",
      mergedIntoBlockId: null,
    });
    expect(proposalOf("p6")).toMatchObject({
      role: "articleHeading",
      mergedIntoBlockId: "p5",
    });
  });

  test("between the title and the parties only a line set like a title belongs to it", () => {
    const manifest = manifestOf([
      "SMLOUVA O DÍLO",
      "uzavřená podle § 2586 občanského zákoníku",
      "č. 12/2026",
      "Tento vzor je pracovní podklad. Před použitím jej upravte podle povahy díla, vyplňte žlutě označená místa a ověřte, že odpovídá zadání.",
      "Objednatel: Horák Stavby s.r.o., se sídlem Dlouhá 1, Praha",
      numbered("1.", "Zhotovitel provede dílo.", 3),
    ]);
    const centred = {
      ...manifest,
      blocks: manifest.blocks.map((block) =>
        block.id === "p1" || block.id === "p2"
          ? { ...block, alignment: "center" }
          : block,
      ),
    };
    expect(rolesOf(centred)).toMatchObject({
      "SMLOUVA O DÍLO": "title",
      "uzavřená podle § 2586 občans": "title",
      "č. 12/2026": "title",
      "Tento vzor je pracovní podkl": "body",
      "Objednatel: Horák Stavby s.r": "party",
    });
  });

  test("a short line without a number that the source centres or sets as a heading heads a part", () => {
    const manifest = manifestOf([
      "SMLOUVA O DÍLO",
      "Alfa s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
      "Beta a.s., se sídlem Krátká 2, Brno, IČO: 00000002",
      "Preambule a účel smlouvy",
      "Strany uzavírají tuto smlouvu.",
      "Článek I.\nPředmět",
      "1.1\tZhotovitel provede dílo.",
      "Zvláštní ujednání",
      "Strany se dohodly na dalších podmínkách.",
      "(dále jen „Podmínky“)",
      "Dílo bude předáno do konce roku.",
      "Bez čísla a bez zarovnání",
    ]);
    const centred = new Set([
      "Preambule a účel smlouvy",
      "Zvláštní ujednání",
      "(dále jen „Podmínky“)",
      "Dílo bude předáno do konce roku.",
    ]);
    for (const block of manifest.blocks) {
      if (centred.has(block.text)) {
        block.alignment = "center";
      }
    }
    const roles = rolesOf(manifest);
    expect(roles["Preambule a účel smlouvy"]).toBe("heading");
    expect(roles["Zvláštní ujednání"]).toBe("heading");
    // A line in brackets, a sentence, a line the source does not set apart.
    expect(roles["(dále jen „Podmínky“)"]).toBe("continuation");
    expect(roles["Dílo bude předáno do konce r"]).toBe("continuation");
    expect(roles["Bez čísla a bez zarovnání"]).toBe("continuation");
  });

  test("a heading right above the sentence that opens the preamble heads it; a centred heading further down the outline stays text", () => {
    const manifest = manifestOf([
      "PURCHASE AGREEMENT",
      "Alfa Ltd, with its registered office at 1 Long Street, London, company number 00000001",
      "and",
      "Beta Ltd, with its registered office at 2 Short Street, Leeds, company number 00000002",
      "Purpose",
      "",
      "The parties have agreed as follows.",
      "Article 1\nSubject",
      "1.1\tThe seller delivers the goods.",
      "Delivery terms",
      "The goods are delivered to the buyer's seat.",
    ]);
    for (const block of manifest.blocks) {
      if (block.text === "Purpose" || block.text === "Delivery terms") {
        block.alignment = "center";
      }
      if (block.text === "Delivery terms") {
        block.outlineLevel = 1;
      }
    }
    const roles = rolesOf(manifest);
    expect(roles["Purpose"]).toBe("heading");
    expect(roles["and"]).toBe("body");
    expect(roles["Beta Ltd, with its registere"]).toBe("party");
    expect(roles["Delivery terms"]).not.toBe("heading");
  });

  test("the line that announces the parties and the word between them are no party's lines", () => {
    const roles = rolesOf(
      manifestOf([
        "KUPNÍ SMLOUVA",
        "uzavřená mezi:",
        "Alfa s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
        "a",
        "Beta a.s., se sídlem Krátká 2, Brno, IČO: 00000002",
        "Článek I.\nPředmět",
        "1.1\tProdávající dodá zboží.",
      ]),
    );
    expect(roles["uzavřená mezi:"]).toBe("body");
    expect(roles["a"]).toBe("body");
    expect(roles["Alfa s.r.o., se sídlem Dlouh"]).toBe("party");
    expect(roles["Beta a.s., se sídlem Krátká "]).toBe("party");
  });

  test("numbered lines that head the parties are parties, and the provisions begin behind them", () => {
    const numberedParties = manifestOf([
      "KUPNÍ SMLOUVA",
      "mezi:",
      numbered("1.", "Alfa s.r.o.", 5),
      "se sídlem Dlouhá 1, Praha",
      "IČO: 00000001",
      "- dále jen „Prodávající“ -",
      "a",
      numbered("2.", "Beta a.s.", 5),
      "se sídlem Krátká 2, Brno",
      "- dále jen „Kupující“ -",
      "Článek I.\nPředmět",
      numbered("1.", "Prodávající dodá zboží.", 10),
      numbered("2.", "Kupující zaplatí cenu.", 10),
    ]);
    const roles = rolesOf(numberedParties);
    expect(roles["Alfa s.r.o."]).toBe("party");
    expect(roles["Beta a.s."]).toBe("party");
    expect(roles["se sídlem Dlouhá 1, Praha"]).toBe("party");
    expect(roles["- dále jen „Kupující“ -"]).toBe("party");
    expect(roles["a"]).toBe("body");
    expect(roles["Prodávající dodá zboží."]).toBe("clause1");
    expect(roles["Kupující zaplatí cenu."]).toBe("clause1");

    // A sentence that concludes the agreement and ends by naming who
    // follows announces the parties; it opens no operative part.
    const announced = rolesOf(
      manifestOf([
        "DOHODA O MLČENLIVOSTI",
        "Tuto dohodu uzavírají níže uvedeného dne následující účastníci:",
        numbered("1.", "Alfa s.r.o., sídlo: Dlouhá 1, Praha", 5),
        "(dále jen „Poskytovatel“)",
        "a",
        numbered("2.", "Beta a.s., IČO: 00000002", 5),
        "(dále jen „Příjemce“)",
        numbered("1.", "Úvodní ujednání", 10),
        numbered("1.1.", "Poskytovatel je správcem díla.", 10),
      ]),
    );
    expect(announced["Alfa s.r.o., sídlo: Dlouhá 1, Praha".slice(0, 28)]).toBe(
      "party",
    );
    expect(announced["Beta a.s., IČO: 00000002"]).toBe("party");

    // A sentence that only ends in a party noun announces no parties.
    const obligations = rolesOf(
      manifestOf([
        "SMLOUVA",
        "Strany se dohodly na těchto povinnostech pro jednotlivé smluvní strany:",
        numbered("1.", "Alfa s.r.o., IČO: 00000001, předá dílo", 5),
        numbered("2.", "Beta a.s., bankovní spojení: účet, zaplatí", 5),
      ]),
    );
    expect(
      obligations["Alfa s.r.o., IČO: 00000001, předá dílo".slice(0, 28)],
    ).not.toBe("party");

    // Letters head them as numbers do, and the second party may have no
    // details of its own behind the word that joins the two.
    const lettered = rolesOf(
      manifestOf([
        "SUPPORT CONTRACT",
        "a) Alpha Ltd, registered office 1 Long Street, London",
        "of the one part and",
        "b) [full official name]",
        "have agreed as follows:",
        "Article 1\nSubject",
        "1.1\tThe supplier delivers the goods.",
      ]),
    );
    expect(lettered["a) Alpha Ltd, registered off"]).toBe("party");
    expect(lettered["b) [full official name]"]).toBe("party");
    expect(lettered["1.1\tThe supplier delivers the goods.".slice(0, 28)]).toBe(
      "clause1",
    );

    // Behind parties without numbers and the sentence that opens the
    // operative part, numbered lines are provisions, whatever they speak
    // of.
    const operative = rolesOf(
      manifestOf([
        "SUPPLY AGREEMENT",
        "Alpha Ltd, registered office 1 Long Street, London",
        "and",
        "Beta Ltd, registered office 2 Short Street, Leeds",
        "have agreed as follows:",
        "1. Notices shall be delivered to the registered office.",
        "2. Each party shall notify changes to its company number.",
      ]),
    );
    expect(
      operative[
        "1. Notices shall be delivered to the registered office.".slice(0, 28)
      ],
    ).toBe("clause1");
    expect(
      operative[
        "2. Each party shall notify changes to its company number.".slice(0, 28)
      ],
    ).toBe("clause1");

    // Numbered provisions that name no party stay provisions, also where
    // a later one speaks of a registered office.
    const provisions = rolesOf(
      manifestOf([
        "SMLOUVA",
        numbered("1.", "Prodávající dodá zboží.", 10),
        numbered("2.", "Kupující, se sídlem v Brně, zaplatí cenu.", 10),
      ]),
    );
    expect(provisions["Prodávající dodá zboží."]).toBe("clause1");
    expect(
      provisions["Kupující, se sídlem v Brně, zaplatí cenu.".slice(0, 28)],
    ).toBe("clause1");
  });

  test("the line that announces the parties is no line of the title, centred or in capitals", () => {
    const lines = (intro: string) => [
      "PURCHASE AGREEMENT",
      intro,
      "Alfa Ltd, with its registered office at 1 Long Street, London, company number 00000001",
      "and",
      "Beta Ltd, with its registered office at 2 Short Street, Leeds, company number 00000002",
      "Article 1\nSubject",
      "1.1\tThe seller delivers the goods.",
    ];
    const centred = manifestOf(lines("between:"));
    for (const block of centred.blocks) {
      if (block.text === "between:") {
        block.alignment = "center";
      }
    }
    expect(rolesOf(centred)["between:"]).toBe("body");
    expect(rolesOf(manifestOf(lines("BY AND BETWEEN")))["BY AND BETWEEN"]).toBe(
      "body",
    );
  });

  test("a bullet whose mark is a letter is a bullet", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I. Rozsah",
      numbered("1.", "Dodavatel uvede:", 1),
      numbered("o", "pevný počet případů,", 2),
      numbered("o", "proměnný počet případů.", 2),
    ]);
    const marked = {
      ...manifest,
      blocks: manifest.blocks.map((block) =>
        block.label === "o" && block.numbering !== null
          ? {
              ...block,
              numbering: { ...block.numbering, bullet: true as const },
            }
          : block,
      ),
    };
    expect(rolesOf(marked)).toMatchObject({
      "pevný počet případů,": "bullet",
      "proměnný počet případů.": "bullet",
    });
    // Without the engine's word for it the mark reads as a letter.
    expect(rolesOf(manifest)["pevný počet případů,"]).not.toBe("bullet");
  });

  test("the proposal of a merged title points at its heading", () => {
    const manifest = czechContract("Text.");
    const proposals = proposeBlockRoles({ manifest });
    expect(
      proposals.find(
        ({ blockId }) => blockId === blockIdOf(manifest, "Úvodní ustanovení"),
      ),
    ).toMatchObject({
      role: "articleHeading",
      mergedIntoBlockId: blockIdOf(manifest, "Článek I."),
    });
  });

  test("confidence follows the evidence", () => {
    const manifest = czechContract("Text.");
    const proposals = proposeBlockRoles({ manifest });
    const confidenceOf = (start: string) =>
      proposals.find(({ blockId }) => blockId === blockIdOf(manifest, start))
        ?.confidence;
    expect(confidenceOf("SMLOUVA O DODÁVCE")).toBe(0.85);
    expect(confidenceOf("Dodavatel:")).toBe(0.85);
    expect(confidenceOf("a")).toBe(0.5);
    expect(confidenceOf("Článek II.")).toBe(0.95);
    expect(confidenceOf("První ujednání, oddíl II.")).toBe(0.9);
    expect(confidenceOf("V Praze dne")).toBe(0.85);
    expect(confidenceOf("Ceny jsou uvedeny")).toBe(0.4);
  });

  test("English and decimal Czech contracts", () => {
    expect(rolesOf(englishAgreement("Text."))).toMatchObject({
      "SERVICES AGREEMENT": "title",
      "Brightwell Hosting Limited, ": "party",
      "(A) The Supplier provides ho": "recital",
      Definitions: "articleHeading",
      "Wording 1.1:": "clause1",
      "first limb;": "letter",
      "first sub-limb; and": "roman",
      "Signed by the parties on the": "signature",
      "Annex 1": "annexHeading",
    });
    expect(rolesOf(czechDecimalContract("Text."))).toMatchObject({
      "RÁMCOVÁ DOHODA": "title",
      "uzavřená mezi stranami:": "body",
      "Nadpis 1": "articleHeading",
      "Znění 1.1.": "clause1",
    });
  });

  test("text under a numbered provision of an annex continues it", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPředmět",
      numbered("1.", "Zhotovitel provede dílo.", 1),
      "Příloha č. 1",
      "Definice",
      numbered("1.", "Pojmy", 2),
      numbered("1.1", "Následující pojmy mají tento význam:", 2),
      "Dílem se rozumí stavba podle projektové dokumentace.",
      numbered("2.", "Rozhodné právo", 2),
      "Tato příloha se řídí českým právem.",
    ]);
    expect(rolesOf(manifest)).toMatchObject({
      "Dílem se rozumí stavba podle": "continuation",
      "Tato příloha se řídí českým ": "continuation",
    });
  });

  test("a drafter's note under a provision is plain text", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPředmět",
      numbered("1.", "Zhotovitel provede dílo.", 1),
      "[Pozn. pro uchazeče: doplní uchazeč podle nabídky.]",
      "Hinweis: Die Parteien können abweichend vereinbaren.",
      "Note that the price is fixed for the whole term.",
    ]);
    expect(rolesOf(manifest)).toMatchObject({
      "[Pozn. pro uchazeče: doplní": "body",
      "Hinweis: Die Parteien können": "body",
      "Note that the price is fixed": "continuation",
    });
  });

  test("a table cell is not taken for the title, and a memo has no signature zone", () => {
    const cells = inColumns(1, ["CONFIDENTIAL"]);
    const memo = manifestOf([
      "MEMORANDUM",
      "Subject: signature validity",
      "Findings follow.",
    ]);
    const blocks = [
      ...cells.blocks,
      ...memo.blocks.map((block) => ({ ...block, id: `m${block.id}` })),
    ];
    const proposals = proposeBlockRoles({ manifest: { blocks } });
    expect(proposals.map(({ blockId, role }) => [blockId, role])).toEqual([
      ["mp0", "title"],
      ["mp1", "body"],
      ["mp2", "body"],
    ]);
  });

  test("a letter or a memo has a title and body text", () => {
    const manifest = manifestOf([
      "MEMORANDUM",
      "Věc: posouzení návrhu",
      "Návrh jsme posoudili a shrnujeme závěry.",
      "S pozdravem",
    ]);
    expect(rolesOf(manifest)).toEqual({
      MEMORANDUM: "title",
      "Věc: posouzení návrhu": "body",
      "Návrh jsme posoudili a shrnu": "body",
      "S pozdravem": "body",
    });
  });

  test("a centred marking right above the title does not take the title's place", () => {
    const manifest = manifestOf([
      "Confidential",
      "AGREEMENT IN PRINCIPLE",
      "Alfa s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
      "Článek I.\nPředmět",
      "1.1\tProdávající dodá zboží.",
    ]);
    const [marking] = manifest.blocks;
    if (marking !== undefined) {
      marking.alignment = "center";
    }
    const roles = rolesOf(manifest);
    expect(roles["AGREEMENT IN PRINCIPLE"]).toBe("title");
    expect(roles["Confidential"]).toBe("body");
    // A centred title in ordinary case stays the title when no line shaped
    // as one stands under it.
    const plain = manifestOf([
      "Smlouva o dílo",
      "Alfa s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
      "Článek I.\nPředmět",
      "1.1\tProdávající dodá zboží.",
    ]);
    const [title] = plain.blocks;
    if (title !== undefined) {
      title.alignment = "center";
    }
    expect(rolesOf(plain)["Smlouva o dílo"]).toBe("title");
  });

  test("in a letter or a memo a line that is merely centred does not take the title's place", () => {
    const manifest = manifestOf([
      "Confidential",
      "AGREEMENT IN PRINCIPLE",
      "We set out below what was agreed at the meeting.",
    ]);
    const [marking] = manifest.blocks;
    if (marking !== undefined) {
      marking.alignment = "center";
    }
    expect(rolesOf(manifest)).toEqual({
      Confidential: "body",
      "AGREEMENT IN PRINCIPLE": "title",
      "We set out below what was ag": "body",
    });
  });

  test("a capital letter labels a recital only in front of the operative part", () => {
    const manifest = manifestOf([
      "SMLOUVA O DÍLO",
      numbered("A.", "Objednatel provozuje síť prodejen.", 1),
      numbered("B.", "Zhotovitel dodává pokladní systémy.", 1),
      "Článek I.\nVýklad pojmů",
      numbered("A.", "Základní pojmy", 2),
      numbered("1.", "Dílem se rozumí pokladní systém.", 3),
      numbered("B.", "Technické pojmy", 2),
    ]);
    expect(
      proposeBlockRoles({ manifest }).map(({ blockId, role }) => [
        blockId,
        role,
      ]),
    ).toEqual([
      ["p0", "title"],
      ["p1", "recital"],
      ["p2", "recital"],
      ["p3", "articleHeading"],
      ["p4", "letter"],
      ["p5", "clause1"],
      ["p6", "letter"],
    ]);
  });

  test("blank paragraphs, contents lines and plain table cells get no reading", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      { text: "Článek I. Předmět\t2", styleName: "toc 1" },
      "",
      " \t",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    expect(
      proposeBlockRoles({ manifest }).map(({ blockId }) => blockId),
    ).toEqual(["p0", "p4", "p5"]);
    const cells = inColumns(2, ["položka", "cena"]);
    expect(proposeBlockRoles({ manifest: cells })).toEqual([]);
  });

  test("a number with no words in a table cell counts the rows and is no provision", () => {
    // A list numbers the rows of a table: the first cell of each row holds
    // the number and nothing else.
    const counted = inColumns(2, [
      numbered("1.", "", 7),
      "nález",
      numbered("2.", "", 7),
      "doporučení",
    ]);
    expect(proposeBlockRoles({ manifest: counted })).toEqual([]);
    // With words behind it, a number in a cell is a provision.
    const provisions = inColumns(2, [
      numbered("1.", "Dodavatel dodá zboží.", 7),
      "The supplier delivers the goods.",
    ]);
    expect(
      proposeBlockRoles({ manifest: provisions }).map(({ blockId }) => blockId),
    ).toContain("p0");
  });

  test("a paragraph that holds only a picture is read, a bulleted one is a bullet", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPředmět",
      numbered("1.", "Text:", 1),
      numbered("•", "první odrážka", 2),
      { text: "" },
    ]);
    const picture = manifest.blocks.at(-1);
    if (picture !== undefined) {
      picture.inlineObjects = 1;
    }
    expect(
      proposeBlockRoles({ manifest }).map(({ blockId, role }) => [
        blockId,
        role,
      ]),
    ).toEqual([
      ["p0", "title"],
      ["p1", "articleHeading"],
      ["p2", "clause1"],
      ["p3", "bullet"],
      ["p4", "continuation"],
    ]);
  });

  test("a cell of an ordinary table does not open the signatures", () => {
    const contract = manifestOf([
      "SMLOUVA O DÍLO",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    const inventory = inColumns(2, ["Name: pressure valve", "12 ks"]);
    const after = manifestOf(["Dodávka proběhne do konce měsíce."]);
    const blocks = [
      ...contract.blocks,
      ...inventory.blocks.map((block) => ({
        ...block,
        id: `i${block.id}`,
        ...(block.cells === undefined
          ? {}
          : {
              cells: block.cells.map((cell) => ({
                ...cell,
                blockIds: cell.blockIds.map((id) => `i${id}`),
              })),
            }),
      })),
      ...after.blocks.map((block) => ({ ...block, id: `z${block.id}` })),
    ];
    expect(
      proposeBlockRoles({ manifest: { blocks } }).map(({ blockId, role }) => [
        blockId,
        role,
      ]),
    ).toEqual([
      ["p0", "title"],
      ["p1", "articleHeading"],
      ["p2", "clause1"],
      ["zp0", "continuation"],
    ]);
  });

  test("the cells of a table of parties or of signatures are party and signature lines", () => {
    const contract = manifestOf([
      "SMLOUVA O DÍLO",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    const parties = inColumns(2, [
      "Horák Stavby s.r.o., se sídlem Dlouhá 1, Praha",
      "Tiskárna Vltavín a.s., se sídlem Krátká 2, Brno",
    ]);
    const signatures = inColumns(2, ["V Praze dne ……………", "Za objednatele"]);
    const rename = (
      { blocks }: DocxBlockManifest,
      prefix: string,
    ): DocxBlock[] =>
      blocks.map((block) => ({
        ...block,
        id: `${prefix}${block.id}`,
        ...(block.cells === undefined
          ? {}
          : {
              cells: block.cells.map((cell) => ({
                ...cell,
                blockIds: cell.blockIds.map((id) => `${prefix}${id}`),
              })),
            }),
      }));
    const [title, ...provisions] = contract.blocks;
    const blocks = [
      ...(title === undefined ? [] : [title]),
      ...rename(parties, "a"),
      ...provisions,
      ...rename(signatures, "z"),
    ];
    expect(
      proposeBlockRoles({ manifest: { blocks } }).map(({ blockId, role }) => [
        blockId,
        role,
      ]),
    ).toEqual([
      ["p0", "title"],
      ["ap0", "party"],
      ["ap1", "party"],
      ["p1", "articleHeading"],
      ["p2", "clause1"],
      ["zp0", "signature"],
      ["zp1", "signature"],
    ]);
  });
});
