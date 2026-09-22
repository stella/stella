import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type {
  DocumentAst,
  ParagraphBlock,
} from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { PL_COURTS_RULING_DECISION_TYPES } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  composeDecisionWithSupplements,
  DOCUMENT_SUPPLEMENTS_METADATA_KEY,
  selectSupplementJudgment,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import type {
  StoredSupplement,
  SupplementJudgmentCandidate,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";

type Ruling = SupplementJudgmentCandidate & { id: string };

const RULING_TYPES = PL_COURTS_RULING_DECISION_TYPES;
const OTHER_TYPES = ["zarządzenie", "uzasadnienie bez sentencji"] as const;

const dateArbitrary = fc
  .integer({ min: 0, max: 40 })
  .map((offset) =>
    new Date(Date.UTC(2018, 2, 1 + offset)).toISOString().slice(0, 10),
  );

const rulingsArbitrary = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    decisionDate: fc.option(dateArbitrary, { nil: null }),
    decisionType: fc.option(fc.constantFrom(...RULING_TYPES, ...OTHER_TYPES), {
      nil: null,
    }),
  }),
  { selector: ({ id }) => id, maxLength: 6 },
);

const targetArbitrary = fc.record({
  decisionTypes: fc.constant(RULING_TYPES),
  latestDecisionDate: fc.option(dateArbitrary, { nil: undefined }),
});

const isEligible = (
  { decisionDate, decisionType }: Ruling,
  latestDecisionDate: string | undefined,
): boolean =>
  decisionType !== null &&
  RULING_TYPES.some((type) => type === decisionType) &&
  (decisionDate === null ||
    latestDecisionDate === undefined ||
    decisionDate <= latestDecisionDate);

const selectedId = (
  selection: ReturnType<typeof selectSupplementJudgment<Ruling>>,
): string =>
  selection.type === "judgment" ? selection.judgment.id : selection.type;

describe("the ruling written reasons belong to", () => {
  test("is always a ruling of a target type dated no later than the reasons", () => {
    fc.assert(
      fc.property(targetArbitrary, rulingsArbitrary, (target, candidates) => {
        const selection = selectSupplementJudgment({ target, candidates });
        if (selection.type !== "judgment") {
          return;
        }
        expect(isEligible(selection.judgment, target.latestDecisionDate)).toBe(
          true,
        );
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("is the latest eligible ruling, and a tie or an undated rival is never guessed", () => {
    fc.assert(
      fc.property(targetArbitrary, rulingsArbitrary, (target, candidates) => {
        const selection = selectSupplementJudgment({ target, candidates });
        const eligible = candidates.filter((ruling) =>
          isEligible(ruling, target.latestDecisionDate),
        );
        if (eligible.length === 1) {
          expect(selectedId(selection)).toBe(eligible[0]?.id ?? "");
          return;
        }
        if (selection.type !== "judgment") {
          return;
        }
        const chosen = selection.judgment;
        for (const rival of eligible) {
          if (rival.id === chosen.id) {
            continue;
          }
          // Every rival is dated, and strictly earlier.
          expect(rival.decisionDate).not.toBeNull();
          expect((rival.decisionDate ?? "") < (chosen.decisionDate ?? "")).toBe(
            true,
          );
        }
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("does not depend on the order the docket's rulings are read in", () => {
    fc.assert(
      fc.property(
        targetArbitrary,
        rulingsArbitrary.chain((rulings) =>
          fc.tuple(
            fc.constant(rulings),
            fc.shuffledSubarray(rulings, {
              minLength: rulings.length,
              maxLength: rulings.length,
            }),
          ),
        ),
        (target, [candidates, shuffled]) => {
          expect(
            selectedId(selectSupplementJudgment({ target, candidates })),
          ).toBe(
            selectedId(
              selectSupplementJudgment({ target, candidates: shuffled }),
            ),
          );
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  // The shapes the corpus holds: reasons on the ruling's own date, reasons
  // weeks after it, and a docket holding more than one ruling.
  const target = (latestDecisionDate: string | undefined) => ({
    decisionTypes: RULING_TYPES,
    latestDecisionDate,
  });
  const sentence = {
    id: "wyrok",
    decisionDate: "2018-03-22",
    decisionType: "wyrok",
  };
  const order = {
    id: "postanowienie",
    decisionDate: "2018-01-10",
    decisionType: "postanowienie",
  };

  test("reasons dated with their ruling join it", () => {
    expect(
      selectedId(
        selectSupplementJudgment({
          target: target("2018-03-22"),
          candidates: [sentence],
        }),
      ),
    ).toBe("wyrok");
  });

  test("reasons written after the ruling join it", () => {
    expect(
      selectedId(
        selectSupplementJudgment({
          target: target("2018-04-19"),
          candidates: [sentence],
        }),
      ),
    ).toBe("wyrok");
  });

  test("of several rulings under one docket, reasons join the last one before them", () => {
    expect(
      selectedId(
        selectSupplementJudgment({
          target: target("2018-04-19"),
          candidates: [order, sentence],
        }),
      ),
    ).toBe("wyrok");
    expect(
      selectedId(
        selectSupplementJudgment({
          target: target("2018-02-01"),
          candidates: [order, sentence],
        }),
      ),
    ).toBe("postanowienie");
  });

  test("reasons dated before every ruling, or beside an order only, have no judgment", () => {
    expect(
      selectSupplementJudgment({
        target: target("2017-12-31"),
        candidates: [order, sentence],
      }).type,
    ).toBe("none");
    expect(
      selectSupplementJudgment({
        target: target("2018-04-19"),
        candidates: [
          {
            id: "order",
            decisionDate: "2018-03-22",
            decisionType: "zarządzenie",
          },
        ],
      }).type,
    ).toBe("none");
  });

  test("two rulings on the latest date, or undated reasons over two rulings, are not guessed", () => {
    expect(
      selectSupplementJudgment({
        target: target("2018-04-19"),
        candidates: [
          sentence,
          {
            id: "second",
            decisionDate: "2018-03-22",
            decisionType: "postanowienie",
          },
        ],
      }).type,
    ).toBe("ambiguous");
    expect(
      selectSupplementJudgment({
        target: target(undefined),
        candidates: [order, sentence],
      }).type,
    ).toBe("ambiguous");
  });
});

const astOf = (blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: {
    system: "saos",
    documentId: "judgment",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: "IV Ka 95/18",
    ecli: null,
    court: "Sąd Okręgowy we Wrocławiu",
    decisionDate: "2018-03-22",
    decisionType: "wyrok",
    keywords: [],
    statutes: [],
  },
  blocks,
});

const paragraph = (index: number, text: string): ParagraphBlock => ({
  id: `b${index}`,
  anchorId: `p-${index}`,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

const judgment: IngestionResult = {
  caseNumber: "IV Ka 95/18",
  court: "Sąd Okręgowy we Wrocławiu",
  country: "POL",
  language: "pl",
  decisionDate: "2018-03-22",
  decisionType: "wyrok",
  sourceDocumentId: "339002",
  fulltext: "WYROK\n\nSąd utrzymuje w mocy zaskarżony wyrok.",
  metadata: { saosId: 339_002 },
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: "judgment-hash",
  documentAst: astOf([
    {
      id: "b1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "WYROK" }],
      plainText: "WYROK",
    },
    paragraph(2, "Sąd utrzymuje w mocy zaskarżony wyrok."),
  ]),
};

const reasons: StoredSupplement = {
  sourceDocumentId: "339001",
  kind: DECISION_SUPPLEMENT_KIND.REASONS,
  fulltext: "UZASADNIENIE\n\nApelacja nie zasługiwała na uwzględnienie.",
  documentAst: astOf([
    {
      id: "b1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "UZASADNIENIE" }],
      plainText: "UZASADNIENIE",
    },
    paragraph(2, "Apelacja nie zasługiwała na uwzględnienie."),
  ]),
  sourceHash: "reasons-hash",
  sourceUrl: "https://www.saos.org.pl/judgments/339001",
};

describe("a judgment composed with its reasons", () => {
  test("is the judgment itself where there are none", () => {
    expect(composeDecisionWithSupplements(judgment, [])).toBe(judgment);
  });

  test("reads the ruling, then the reasons, and keeps every anchor distinct", () => {
    const composed = composeDecisionWithSupplements(judgment, [reasons]);
    expect(composed.fulltext).toBe(
      `${judgment.fulltext ?? ""}\n\n${reasons.fulltext ?? ""}`,
    );
    if (!("blocks" in composed.documentAst)) {
      throw new Error("the composed document lost its blocks");
    }
    const { blocks } = composed.documentAst;
    expect(blocks.map(({ plainText }) => plainText)).toEqual([
      "WYROK",
      "Sąd utrzymuje w mocy zaskarżony wyrok.",
      "UZASADNIENIE",
      "Apelacja nie zasługiwała na uwzględnienie.",
    ]);
    // Both documents number from one; only the judgment's anchors keep
    // their own names, so a link into the ruling still lands on it.
    expect(blocks.slice(0, 2).map(({ anchorId }) => anchorId)).toEqual([
      "h-1",
      "p-2",
    ]);
    expect(new Set(blocks.map(({ anchorId }) => anchorId)).size).toBe(
      blocks.length,
    );
    expect(new Set(blocks.map(({ id }) => id)).size).toBe(blocks.length);
    // One title: the reasons open a section of the judgment.
    expect(
      blocks.filter(
        (block) => block.type === "heading" && block.role === "decision-title",
      ),
    ).toHaveLength(1);
    expect(composed.metadata[DOCUMENT_SUPPLEMENTS_METADATA_KEY]).toEqual([
      {
        kind: DECISION_SUPPLEMENT_KIND.REASONS,
        sourceDocumentId: "339001",
        sourceUrl: "https://www.saos.org.pl/judgments/339001",
      },
    ]);
  });

  test("hashes the observation and every supplement version, and nothing else", () => {
    const composed = composeDecisionWithSupplements(judgment, [reasons]);
    expect(composed.rawHash).not.toBe(judgment.rawHash);
    expect(composeDecisionWithSupplements(judgment, [reasons]).rawHash).toBe(
      composed.rawHash,
    );
    expect(
      composeDecisionWithSupplements(judgment, [
        { ...reasons, sourceHash: "edited-reasons-hash" },
      ]).rawHash,
    ).not.toBe(composed.rawHash);
  });

  test("keeps reasons text a parser could not structure", () => {
    const unparsed = {
      ...reasons,
      documentAst: {},
      fulltext: "UZASADNIENIE\n\nPierwszy akapit.\n\n  \n\nDrugi akapit.",
    };
    const composed = composeDecisionWithSupplements(judgment, [unparsed]);
    if (!("blocks" in composed.documentAst)) {
      throw new Error("the composed document lost its blocks");
    }
    expect(
      composed.documentAst.blocks.slice(2).map(({ plainText }) => plainText),
    ).toEqual(["UZASADNIENIE", "Pierwszy akapit.", "Drugi akapit."]);
  });
});
