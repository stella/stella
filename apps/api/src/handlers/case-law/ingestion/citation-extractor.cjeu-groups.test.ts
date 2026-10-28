import { expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { deriveDecisionReferences } from "@/api/handlers/case-law/citations/decision-references";
import { toSafeId } from "@/api/lib/branded-types";

import { extractCitations } from "./citation-extractor";

const identities = (text: string, language?: string) =>
  extractCitations([{ index: 0, text }], { language })
    .map(({ citationText, identifierType, identifierValue }) => [
      citationText,
      identifierType,
      identifierValue,
    ])
    // Code-unit order: the keys are identifiers, not words.
    .toSorted(([left = ""], [right = ""]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    });

const PARAGRAPH =
  "viz rozsudky ze dne 1. června 2010, Blanco Pérez a Chao Gómez, C‑570/07 a C‑571/07, EU:C:2010:300, bod 40, a ze dne 5. prosince 2013, Venturini a další, C‑159/12 až C‑161/12, EU:C:2013:791, body 25 a 26.";

test("every case a joined or ranged reference names is a citation, pinned to the printed ECLI", () => {
  expect(identities(PARAGRAPH, "cs")).toEqual([
    ["C‑159/12", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:791"],
    ["C‑160/12", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:791"],
    ["C‑161/12", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:791"],
    ["C‑570/07", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2010:300"],
    ["C‑571/07", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2010:300"],
    ["EU:C:2010:300", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2010:300"],
    ["EU:C:2013:791", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:791"],
  ]);
});

test("the same reference reads alike in English and German", () => {
  for (const [language, text] of [
    ["en", "Venturini and Others, C‑159/12 to C‑161/12, EU:C:2013:791"],
    ["de", "Venturini u. a., C‑159/12 bis C‑161/12, EU:C:2013:791"],
  ] as const) {
    expect(identities(text, language).map(([printed]) => printed)).toEqual([
      "C‑159/12",
      "C‑160/12",
      "C‑161/12",
      "EU:C:2013:791",
    ]);
  }
});

test("a number printed without an ECLI keeps its case-number identity", () => {
  expect(identities("spojené věci C‑570/07 a C‑571/07", "cs")).toEqual([
    ["C‑570/07", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "C‑570/07"],
    ["C‑571/07", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "C‑571/07"],
  ]);
});

test("a number printed with two different ECLIs is pinned to neither", () => {
  // The judgment and the Advocate General's opinion share the case number.
  expect(
    identities(
      "rozsudek Venturini (C‑159/12 až C‑161/12, EU:C:2013:791) a stanovisko (C‑159/12 až C‑161/12, EU:C:2013:529)",
      "cs",
    ),
  ).toEqual([
    ["C‑159/12", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "C‑159/12"],
    ["C‑160/12", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "C‑160/12"],
    ["C‑161/12", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "C‑161/12"],
    ["EU:C:2013:529", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:529"],
    ["EU:C:2013:791", DECISION_IDENTIFIER_TYPES.ECLI, "EU:C:2013:791"],
  ]);
});

test("a joined second number resolves through the judgment's ECLI, not the file it shares", () => {
  const { references } = deriveDecisionReferences({
    citingDecisionId: toSafeId<"caseLawDecision">(
      "01a11491-521d-705a-9cd9-8ad4818b5de9",
    ),
    citations: extractCitations(
      [
        {
          index: 0,
          text: "(v tomto smyslu viz rozsudek ze dne 21. prosince 2011, N. S. a další, C‑411/10 a C‑493/10, EU:C:2011:865, bod 93)",
        },
      ],
      { language: "cs" },
    ),
    proceduralKeys: new Set(),
    sections: [{ text: "" }],
  });
  expect(
    references.map(({ printed, citationKey, identifiers }) => ({
      printed,
      citationKey,
      identifiers,
    })),
  ).toEqual([
    {
      printed: "C‑411/10",
      citationKey: expect.any(String),
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          normalizedValue: "euc2011865",
        },
      ],
    },
    {
      printed: "C‑493/10",
      citationKey: expect.any(String),
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          normalizedValue: "euc2011865",
        },
      ],
    },
    {
      printed: "EU:C:2011:865",
      citationKey: expect.any(String),
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          normalizedValue: "euc2011865",
        },
      ],
    },
  ]);
});
