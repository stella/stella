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
