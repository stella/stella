import { describe, expect, test } from "bun:test";

import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/house-style/folio-contract";
import {
  blockIdOf,
  czechContract,
  czechDecimalContract,
  englishAgreement,
  manifestOf,
  numbered,
} from "@/api/lib/house-style/manifest.test-helpers";
import { proposeTemplateRoles } from "@/api/lib/house-style/role-proposer";
import type {
  HouseStyleRole,
  TemplateRoleMap,
} from "@/api/lib/house-style/role-proposer";

/** One multi-level list numbers articles, clauses, letters and points, the
 *  way a contract template binds them to its styles. */
const LIST = 18;
const ROLE_MAP = {
  title: { styleId: "Title", numbering: null },
  party: { styleId: "Party", numbering: null },
  articleHeading: { styleId: "Article", numbering: { numId: LIST, ilvl: 0 } },
  clause1: { styleId: "Clause1", numbering: { numId: LIST, ilvl: 1 } },
  clause2: { styleId: "Clause2", numbering: { numId: LIST, ilvl: 2 } },
  clause3: null,
  letter: { styleId: "Letter", numbering: { numId: LIST, ilvl: 3 } },
  roman: { styleId: "Roman", numbering: { numId: LIST, ilvl: 4 } },
  continuation: { styleId: "Continuation", numbering: null },
  signature: { styleId: "Signature", numbering: null },
  annexList: { styleId: "AnnexList", numbering: null },
  annexHeading: { styleId: "AnnexHeading", numbering: null },
  body: { styleId: "Body", numbering: null },
} as const satisfies TemplateRoleMap;

const rolesOf = (
  manifest: DocxBlockManifest,
): Record<string, HouseStyleRole> => {
  const { proposals } = proposeTemplateRoles({ manifest, roleMap: ROLE_MAP });
  const textById = new Map(manifest.blocks.map(({ id, text }) => [id, text]));
  return Object.fromEntries(
    proposals.map(({ blockId, role }) => [
      (textById.get(blockId) ?? "").split("\n").join(" ").slice(0, 28),
      role,
    ]),
  );
};

describe("proposeTemplateRoles", () => {
  test("reads the parts of a Czech contract", () => {
    const manifest = czechContract("Viz čl. II této smlouvy.");
    expect(rolesOf(manifest)).toMatchObject({
      "SMLOUVA O DODÁVCE": "title",
      "Dodavatel: Vzorová dodavatel": "party",
      "(dále jen „dodavatel“)": "party",
      a: "party",
      "uzavírají tuto smlouvu:": "body",
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

  test("plan items carry the template's style and list level", () => {
    const manifest = czechContract("Viz čl. II této smlouvy.");
    const { body, omit } = proposeTemplateRoles({
      manifest,
      roleMap: ROLE_MAP,
    });
    const itemOf = (start: string) =>
      body.find(({ blockId }) => blockId === blockIdOf(manifest, start));
    expect(omit).toEqual([]);
    expect(itemOf("SMLOUVA")).toEqual({
      kind: "source",
      blockId: "p0",
      hash: "h0",
      styleId: "Title",
      numbering: null,
    });
    // The typed label goes; the list prints it. The split title is merged.
    expect(itemOf("Článek I.")).toMatchObject({
      styleId: "Article",
      numbering: { numId: LIST, ilvl: 0 },
      stripLabel: "Článek I.",
      mergeNext: "lineBreak",
    });
    expect(itemOf("Úvodní ustanovení")).toBeUndefined();
    expect(itemOf("Článek II.")).toMatchObject({
      numbering: { numId: LIST, ilvl: 0 },
      stripLabel: "Článek II.",
    });
    expect(itemOf("Článek II.")).not.toHaveProperty("mergeNext");
    expect(itemOf("První ujednání, oddíl II.")).toMatchObject({
      styleId: "Clause1",
      numbering: { numId: LIST, ilvl: 1 },
    });
    expect(itemOf("První ujednání, oddíl II.")).not.toHaveProperty(
      "stripLabel",
    );
    expect(itemOf("první případ;")).toMatchObject({
      styleId: "Letter",
      numbering: { numId: LIST, ilvl: 3 },
    });
    expect(itemOf("první podbod,")).toMatchObject({
      styleId: "Roman",
      numbering: { numId: LIST, ilvl: 4 },
    });
  });

  test("the proposal of a merged title points at its heading", () => {
    const manifest = czechContract("Text.");
    const { proposals } = proposeTemplateRoles({ manifest, roleMap: ROLE_MAP });
    expect(
      proposals.find(
        ({ blockId }) => blockId === blockIdOf(manifest, "Úvodní ustanovení"),
      ),
    ).toMatchObject({
      role: "articleHeading",
      mergedIntoBlockId: blockIdOf(manifest, "Článek I."),
    });
  });

  test("a list restarts wherever the template would count past the source", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec:", 1),
      numbered("a)", "případ;", 2),
      numbered("b)", "případ.", 2),
      "Pokračování odstavce, po němž výčet začíná znovu:",
      numbered("a)", "případ;", 3),
      numbered("2.", "Odstavec.", 1),
      "Článek III.\nTřetí, druhý článek chybí",
      numbered("1.", "Odstavec.", 4),
      numbered("5.", "Odstavec s přeskočeným číslem.", 4),
      numbered("6.", "Odstavec.", 4),
    ]);
    const { body } = proposeTemplateRoles({ manifest, roleMap: ROLE_MAP });
    expect(body.map(({ numbering }) => numbering)).toEqual([
      null,
      { numId: LIST, ilvl: 0 },
      { numId: LIST, ilvl: 1 },
      { numId: LIST, ilvl: 3 },
      { numId: LIST, ilvl: 3 },
      null,
      { numId: LIST, ilvl: 3, restartFrom: 1 },
      { numId: LIST, ilvl: 1 },
      { numId: LIST, ilvl: 0, restartFrom: 3 },
      { numId: LIST, ilvl: 1 },
      { numId: LIST, ilvl: 1, restartFrom: 5 },
      { numId: LIST, ilvl: 1 },
    ]);
  });

  test("empty paragraphs and the source's table of contents are omitted", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      { text: "Článek I. Předmět\t2", styleName: "toc 1" },
      "",
      " \t",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    const { body, omit } = proposeTemplateRoles({
      manifest,
      roleMap: ROLE_MAP,
    });
    expect(omit).toEqual([
      { blockId: "p1", reason: "sourceToc" },
      { blockId: "p2", reason: "empty" },
      { blockId: "p3", reason: "empty" },
    ]);
    expect(body.map(({ blockId }) => blockId)).toEqual(["p0", "p4", "p5"]);
  });

  test("a table is placed whole and its cells are not placed again", () => {
    const manifest = manifestOf(["SMLOUVA", "buňka vlevo", "buňka vpravo"]);
    const blocks = manifest.blocks.flatMap((block): DocxBlock[] =>
      block.id === "p1"
        ? [
            {
              ...block,
              id: "t0",
              kind: "table",
              text: "buňka vlevo\nbuňka vpravo",
              hash: "ht",
              cells: [
                { row: 0, col: 0, blockIds: ["p1"] },
                { row: 0, col: 1, blockIds: ["p2"] },
              ],
            },
            block,
          ]
        : [block],
    );
    const { body, proposals } = proposeTemplateRoles({
      manifest: { blocks },
      roleMap: ROLE_MAP,
    });
    expect(body).toEqual([
      {
        kind: "source",
        blockId: "p0",
        hash: "h0",
        styleId: "Title",
        numbering: null,
      },
      { kind: "source", blockId: "t0", hash: "ht" },
    ]);
    expect(proposals.map(({ blockId }) => blockId)).toEqual(["p0"]);
  });

  test("a role the template lacks falls back to body and is reported", () => {
    const manifest = manifestOf([
      { text: "Services", label: "1.", styleName: "heading 1" },
      numbered("1.1", "Clause."),
      numbered("1.1.1", "Sub-clause."),
      numbered("1.1.1.1", "Sub-sub-clause."),
    ]);
    const { body, proposals, unmappedRoles } = proposeTemplateRoles({
      manifest,
      roleMap: ROLE_MAP,
    });
    expect(proposals.map(({ role }) => role)).toEqual([
      "articleHeading",
      "clause1",
      "clause2",
      "clause3",
    ]);
    expect(unmappedRoles).toEqual(["clause3"]);
    expect(body.at(-1)).toEqual({
      kind: "source",
      blockId: "p3",
      hash: "h3",
      styleId: "Body",
      numbering: null,
    });
  });

  test("confidence follows the evidence", () => {
    const manifest = czechContract("Text.");
    const { proposals } = proposeTemplateRoles({ manifest, roleMap: ROLE_MAP });
    const confidenceOf = (start: string) =>
      proposals.find(({ blockId }) => blockId === blockIdOf(manifest, start))
        ?.confidence;
    expect(confidenceOf("SMLOUVA O DODÁVCE")).toBe(0.85);
    expect(confidenceOf("Dodavatel:")).toBe(0.85);
    expect(confidenceOf("a")).toBe(0.6);
    expect(confidenceOf("Článek II.")).toBe(0.95);
    expect(confidenceOf("První ujednání, oddíl II.")).toBe(0.9);
    expect(confidenceOf("V Praze dne")).toBe(0.85);
    expect(confidenceOf("Ceny jsou uvedeny")).toBe(0.4);
  });

  test("English and decimal Czech contracts", () => {
    expect(rolesOf(englishAgreement("Text."))).toMatchObject({
      "SERVICES AGREEMENT": "title",
      "Example Supplier Limited, a ": "party",
      "(A) The Supplier provides ho": "body",
      Definitions: "articleHeading",
      "Wording 1.1:": "clause1",
      "first limb;": "letter",
      "first sub-limb; and": "roman",
      "Signed by the parties on the": "signature",
      "Annex 1": "annexHeading",
    });
    expect(rolesOf(czechDecimalContract("Text."))).toMatchObject({
      "RÁMCOVÁ DOHODA": "title",
      "uzavřená mezi stranami:": "title",
      "Nadpis 1": "articleHeading",
      "Znění 1.1.": "clause1",
    });
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
});
