import { describe, expect, test } from "bun:test";

import {
  checkTranslationConsistency,
  defaultDisposition,
  detectGlossaryCandidates,
  ruleDisposition,
} from "@/api/lib/bilingual/rows";
import type { BilingualUnit } from "@/api/lib/bilingual/rows";

const unit = (sourceText: string, inTable = false): BilingualUnit => ({
  rowId: "r",
  ordinal: 1,
  kind: inTable ? "table" : "paragraph",
  inTable,
  sourceParaId: "p",
  sourceText,
});

describe("ruleDisposition", () => {
  test("keeps rows without letters and already-bilingual lines; leaves prose undecided", () => {
    expect(ruleDisposition(unit("_______________"))).toBe("keep");
    expect(ruleDisposition(unit("1 250 000,00"))).toBe("keep");
    expect(ruleDisposition(unit("23. 7. 2018"))).toBe("keep");
    expect(ruleDisposition(unit("NÁJEMNÍ SMLOUVA / TENANCY AGREEMENT"))).toBe(
      "keep",
    );
    expect(
      ruleDisposition(unit("Smluvní strany se dohodly takto:")),
    ).toBeNull();
    // A slash inside prose is not a bilingual marker.
    expect(
      ruleDisposition(unit("Nájemce a/nebo Pronajímatel uhradí")),
    ).toBeNull();
  });

  test("undecided rows default to the redundant direction", () => {
    expect(defaultDisposition(unit("Podpis:"))).toBe("translate");
    expect(defaultDisposition(unit("Podpis:", true))).toBe("inline");
  });
});

describe("detectGlossaryCandidates", () => {
  test("finds quoted and parenthesised defined terms once, in document order", () => {
    const texts = [
      "Tuto smlouvu (dále jen „Smlouva“) uzavírají Royal Peak s.r.o. (dále jen Pronajímatel)",
      'and the tenant (hereinafter referred to as the "Tenant"), together the “Parties”.',
      "Pronajímatel přenechává Nájemci byt („Nemovitost“). „Smlouva“ se řídí právem ČR.",
      "„velmi dlouhý text, který není definovaným pojmem, protože začíná malým písmenem“",
    ];
    expect(detectGlossaryCandidates(texts)).toEqual([
      "Smlouva",
      "Pronajímatel",
      "Tenant",
      "Parties",
      "Nemovitost",
    ]);
  });
});

describe("checkTranslationConsistency", () => {
  const glossary = [
    {
      source: "Smlouva",
      target: "Agreement",
      sourceForms: ["Smlouvy", "Smlouvě", "Smlouvou"],
      targetForms: ["Agreement's"],
      origin: "user" as const,
    },
    {
      source: "Pronajímatel",
      target: "Landlord",
      sourceForms: ["Pronajímatele", "Pronajímateli"],
      targetForms: [],
      origin: "user" as const,
    },
  ];

  test("passes when every present term uses its rendering and numbers survive", () => {
    expect(
      checkTranslationConsistency({
        sourceText:
          "Pronajímatel uzavírá tuto Smlouvu na 24 měsíců za 15 000 Kč.",
        targetText:
          "The Landlord concludes this Agreement for 24 months for CZK 15 000.",
        glossary,
      }),
    ).toEqual([]);
  });

  test("reports a term rendered differently and a number that vanished", () => {
    const warnings = checkTranslationConsistency({
      sourceText: "Pronajímatel uzavírá tuto Smlouvu na 24 měsíců.",
      targetText: "The Lessor concludes this Contract for two years.",
      glossary,
    });
    expect(warnings).toEqual([
      '"Smlouva" should be rendered as "Agreement"',
      '"Pronajímatel" should be rendered as "Landlord"',
      'Number "24" is missing from the translation',
    ]);
  });

  test("matches declined source forms, not just the headword", () => {
    // The fixture must differ from the headword for this to prove anything.
    expect("Smlouvě").not.toBe("Smlouva");
    expect(
      checkTranslationConsistency({
        sourceText: "V této Smlouvě se sjednává",
        targetText: "In this Contract it is agreed",
        glossary,
      }),
    ).toEqual(['"Smlouva" should be rendered as "Agreement"']);
  });

  test("ignores terms absent from the source row", () => {
    expect(
      checkTranslationConsistency({
        sourceText: "Nájemce platí včas.",
        targetText: "The Tenant pays on time.",
        glossary,
      }),
    ).toEqual([]);
  });
});
