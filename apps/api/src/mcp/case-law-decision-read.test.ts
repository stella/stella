import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { DecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { RankedRelatedDecision } from "@/api/handlers/case-law/decisions/citation-graph";
import {
  brandPersistedCaseLawCitationId,
  brandPersistedCaseLawDecisionId,
} from "@/api/lib/safe-id-boundaries";
import {
  citationSummaryOutput,
  compactDecisionMetadata,
  decisionParagraphs,
  decisionTextVersion,
  pageOfOffset,
  paragraphsMatching,
  QUERY_HIT_LIMIT,
  rankCitingDecisions,
  textPageSpan,
  textPageStarts,
  TOP_CITING_DECISIONS,
} from "@/api/mcp/case-law-decision-read";

const decisionId = (n: number) =>
  brandPersistedCaseLawDecisionId(
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );

const related = (
  n: number,
  overrides: Partial<RankedRelatedDecision> = {},
): RankedRelatedDecision => ({
  id: decisionId(n),
  caseNumber: `${String(n)} Cdo ${String(n)}/2020`,
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationAuthority: 0,
  country: "CZE",
  court: "Nejvyšší soud",
  decisionDate: "2020-01-01",
  decisionType: "rozsudek",
  ecli: null,
  language: "cs",
  languageAlternates: [],
  slug: `ns-${String(n)}`,
  ...overrides,
});

const counts = (
  values: Partial<DecisionCitationDigest["summary"]["incoming"]> = {},
) => ({
  negative: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  mixed: 0,
  unclassified: 0,
  ...values,
});

const digestOf = (
  overrides: Partial<DecisionCitationDigest> = {},
): DecisionCitationDigest => ({
  summary: {
    incoming: counts(),
    outgoing: counts(),
    capped: { incoming: false, outgoing: false },
    incomingByYear: [],
  },
  topCiting: [],
  cites: [],
  citesMore: false,
  ...overrides,
});

const appUrlOf = (decision: RankedRelatedDecision) =>
  `https://app.test/law/${decision.slug ?? "x"}`;

describe("text pages", () => {
  test.each([
    { length: 10, size: 5, pages: 2 },
    { length: 11, size: 5, pages: 3 },
    { length: 4, size: 5, pages: 1 },
    { length: 5, size: 5, pages: 1 },
    { length: 1, size: 1, pages: 1 },
  ])(
    "$length chars at $size per page is $pages pages",
    ({ length, size, pages }) => {
      const text = "a".repeat(length);
      const starts = textPageStarts(text, size);
      expect(starts).toHaveLength(pages);
      // The pages tile the text: no gap, no overlap, last one partial.
      const spans = starts.map((_, index) =>
        textPageSpan({ page: index + 1, starts, text }),
      );
      expect(
        spans.map((span) => text.slice(span?.start, span?.end)).join(""),
      ).toBe(text);
      expect(spans.at(-1)?.end).toBe(length);
    },
  );

  test("the last page is the partial remainder", () => {
    const text = "0123456789AB";
    const starts = textPageStarts(text, 5);
    expect(textPageSpan({ page: 3, starts, text })).toEqual({
      start: 10,
      end: 12,
    });
  });

  test("a page past the last one has no span", () => {
    const text = "0123456789";
    const starts = textPageStarts(text, 5);
    expect(textPageSpan({ page: 3, starts, text })).toBeNull();
  });

  test("pages never split a supplementary character", () => {
    const text = "𠮷A𠮷";
    const starts = textPageStarts(text, 1);
    const pages = starts.map((_, index) => {
      const span = textPageSpan({ page: index + 1, starts, text });
      return text.slice(span?.start, span?.end);
    });
    expect(pages).toEqual(["𠮷", "A", "𠮷"]);
  });

  test("an offset lands on the page holding it", () => {
    const starts = textPageStarts("a".repeat(12), 5);
    expect(
      [0, 4, 5, 9, 10, 11, 99].map((offset) => pageOfOffset(starts, offset)),
    ).toEqual([1, 1, 2, 2, 3, 3, 3]);
  });
});

describe("text version", () => {
  test("is short, stable and changes with the text", () => {
    const version = decisionTextVersion("The court dismissed the appeal.");
    expect(version.length).toBeLessThanOrEqual(24);
    expect(version).toBe(
      decisionTextVersion("The court dismissed the appeal."),
    );
    expect(version).not.toBe(
      decisionTextVersion("The court allowed the appeal."),
    );
  });
});

describe("compact metadata", () => {
  test("drops values stated elsewhere, duplicates and empties", () => {
    expect(
      compactDecisionMetadata({
        metadata: {
          caseNumber: "21 Cdo 1484/2004",
          court: "Nejvyšší soud",
          decisionDate: "2004-06-30",
          decisionType: "Rozsudek",
          ecli: "ECLI:CZ:NS:2004:21.CDO.1484.2004.1",
          category: "D",
          kategorieRozhodnuti: "D",
          keywords: ["výpověď"],
          heslo: ["výpověď"],
          statutes: [],
          judge: "JUDr. A",
          note: " ",
          published: true,
          reviewed: true,
          pages: 3,
          volume: 3,
        },
        restated: [
          "21 Cdo 1484/2004",
          "Nejvyšší soud",
          "2004-06-30",
          "rozsudek",
          "ECLI:CZ:NS:2004:21.CDO.1484.2004.1",
          null,
        ],
      }),
    ).toEqual({
      category: "D",
      heslo: ["výpověď"],
      judge: "JUDr. A",
      // Flags and counts are distinct facts even when equal.
      published: true,
      reviewed: true,
      pages: 3,
      volume: 3,
    });
  });
});

describe("citation summary", () => {
  test("counts every treatment and names only those that occur", () => {
    const summary = citationSummaryOutput(
      digestOf({
        summary: {
          incoming: counts({ positive: 2, unclassified: 47, negative: 1 }),
          outgoing: counts({ neutral: 3 }),
          capped: { incoming: true, outgoing: false },
          incomingByYear: [],
        },
      }),
      appUrlOf,
    );
    expect(summary.citedBy).toEqual({
      count: 50,
      capped: true,
      polarity: { negative: 1, positive: 2, unclassified: 47 },
    });
    expect(summary.cites).toEqual({ count: 3 });
  });

  test("an uncited decision says so in one field", () => {
    expect(citationSummaryOutput(digestOf(), appUrlOf)).toEqual({
      citedBy: { count: 0 },
      cites: { count: 0 },
    });
  });

  test("top citing decisions: authority first, then the most recent, at most five", () => {
    const ranked = rankCitingDecisions([
      related(1, { citationAuthority: 1, decisionDate: "2010-01-01" }),
      related(2, { citationAuthority: 3, decisionDate: "2001-01-01" }),
      related(3, { citationAuthority: 1, decisionDate: "2020-01-01" }),
      related(4, { citationAuthority: 0, decisionDate: null }),
      related(5, { citationAuthority: 0, decisionDate: "2022-01-01" }),
      related(6, { citationAuthority: 2, decisionDate: "2015-01-01" }),
      related(7, { citationAuthority: 1, decisionDate: "2020-01-01" }),
      // A decision citing twice is one row.
      related(2, { citationAuthority: 3, decisionDate: "2001-01-01" }),
    ]);
    expect(ranked.map(({ id }) => id)).toEqual([
      decisionId(2),
      decisionId(6),
      decisionId(3),
      decisionId(7),
      decisionId(1),
    ]);
    expect(ranked).toHaveLength(TOP_CITING_DECISIONS);
  });

  test("a top row is a citable name, a link and the id to read it by", () => {
    const summary = citationSummaryOutput(
      digestOf({
        summary: { ...digestOf().summary, incoming: counts({ positive: 1 }) },
        topCiting: [related(9, { decisionDate: null })],
      }),
      appUrlOf,
    );
    expect(summary.citedBy.top).toEqual([
      {
        caseNumber: "9 Cdo 9/2020",
        court: "Nejvyšší soud",
        decisionId: decisionId(9),
        url: "https://app.test/law/ns-9",
      },
    ]);
  });

  test("what it cites: one entry per decision or text, an id only when held", () => {
    const row = (
      n: number,
      citationText: string,
      decision: RankedRelatedDecision | null,
    ) => ({
      id: brandPersistedCaseLawCitationId(
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      ),
      citationText,
      textWithheldReason: null,
      sectionIndex: n,
      treatment: "unclassified" as const,
      decision,
    });
    const summary = citationSummaryOutput(
      digestOf({
        cites: [
          row(1, "sp. zn. 29 Odo 1/2001", null),
          row(2, "29 Odo 1/2001 ", null),
          row(3, "sp. zn. 29 ODO 1/2001", null),
          row(4, "21 Cdo 5/2019", related(5)),
          row(5, "sp. zn. 21 Cdo 5/2019", related(5)),
        ],
        citesMore: true,
      }),
      appUrlOf,
    );
    expect(summary.cites.decisions).toEqual([
      { citation: "sp. zn. 29 Odo 1/2001", textWithheldReason: null },
      { citation: "29 Odo 1/2001", textWithheldReason: null },
      {
        caseNumber: "5 Cdo 5/2020",
        decisionId: decisionId(5),
        url: "https://app.test/law/ns-5",
      },
    ]);
    expect(summary.cites.more).toBe(true);
  });

  test("restricted unresolved citation text is represented only by its marker", () => {
    const summary = citationSummaryOutput(
      digestOf({
        cites: [
          {
            id: brandPersistedCaseLawCitationId(
              "00000000-0000-4000-8000-000000000099",
            ),
            citationText: null,
            textWithheldReason: "source_licence",
            sectionIndex: null,
            treatment: "unclassified",
            decision: null,
          },
        ],
      }),
      appUrlOf,
    );
    expect(summary.cites.decisions).toEqual([
      { citation: null, textWithheldReason: "source_licence" },
    ]);
  });
});

describe("paragraphs matching a query", () => {
  const paragraphs = decisionParagraphs({
    located: null,
    text: [
      "Úvod.",
      "Nájemce zaplatil nájemné včas.",
      "Mezitím.",
      "Soud posoudil výpověď z nájmu.",
      "Závěr.",
    ].join("\n"),
  });

  test("finds a word in any inflection, with its neighbours", () => {
    const found = paragraphsMatching({
      budget: 8000,
      language: "cs",
      paragraphs,
      query: "nájemného",
    });
    expect(found.hitCount).toBe(1);
    expect(
      found.paragraphs.map(({ paragraph, hit }) => [paragraph, hit]),
    ).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  test("every word must occur, case and accents aside", () => {
    const found = paragraphsMatching({
      budget: 8000,
      language: "xx",
      paragraphs,
      query: "SOUD vypoved",
    });
    expect(
      found.paragraphs
        .filter(({ hit }) => hit)
        .map(({ paragraph }) => paragraph),
    ).toEqual([4]);
  });

  test("overlapping neighbourhoods are not repeated", () => {
    const found = paragraphsMatching({
      budget: 8000,
      language: "xx",
      paragraphs: decisionParagraphs({ located: null, text: "a x\nb x\nc x" }),
      query: "x",
    });
    expect(found.paragraphs.map(({ paragraph }) => paragraph)).toEqual([
      1, 2, 3,
    ]);
  });

  test("hits beyond the limit or the budget are counted, not returned", () => {
    const many = decisionParagraphs({
      located: null,
      // Hits apart, so no neighbour shown for context is itself a hit.
      text: Array.from({ length: 60 }, () => "hit\nother").join("\n"),
    });
    const capped = paragraphsMatching({
      budget: 1_000_000,
      language: "xx",
      paragraphs: many,
      query: "hit",
    });
    expect(capped.hitCount).toBe(60);
    expect(capped.paragraphs.filter(({ hit }) => hit)).toHaveLength(
      QUERY_HIT_LIMIT,
    );
    expect(capped.truncated).toBe(true);

    const tight = paragraphsMatching({
      budget: 10,
      language: "xx",
      paragraphs: many,
      query: "hit",
    });
    expect(tight.truncated).toBe(true);
    expect(
      tight.paragraphs.map(({ text }) => text).join("").length,
    ).toBeLessThanOrEqual(10);
  });

  test("a match between two long neighbours stays within the budget", () => {
    // Each paragraph alone is longer than the budget: the match is cut to
    // it and neither neighbour fits what is left.
    const long = (word: string) => `${word} ${"x".repeat(9000)}`;
    const found = paragraphsMatching({
      budget: 8000,
      language: "xx",
      paragraphs: [
        { anchorId: null, text: long("before") },
        { anchorId: null, text: long("match") },
        { anchorId: null, text: long("after") },
      ],
      query: "match",
    });
    expect(
      found.paragraphs.reduce((sum, { text }) => sum + text.length, 0),
    ).toBeLessThanOrEqual(8000);
    expect(found.paragraphs.map(({ paragraph }) => paragraph)).toEqual([2]);
    expect(found.truncated).toBe(true);
  });

  test("a neighbour that fits what is left still travels", () => {
    const found = paragraphsMatching({
      budget: 20,
      language: "xx",
      paragraphs: [
        { anchorId: null, text: "short" },
        { anchorId: null, text: "match here" },
        { anchorId: null, text: "much too long to fit" },
      ],
      query: "match",
    });
    expect(found.paragraphs.map(({ paragraph }) => paragraph)).toEqual([1, 2]);
    expect(found.truncated).toBe(true);
  });

  test("a paragraph longer than the budget is cut to it", () => {
    const found = paragraphsMatching({
      budget: 5,
      language: "xx",
      paragraphs: [{ anchorId: "p-1", text: "match and much more text" }],
      query: "match",
    });
    expect(found.paragraphs).toEqual([
      { anchorId: "p-1", text: "match", paragraph: 1, hit: true },
    ]);
  });

  test("blocks keep their fragments", () => {
    expect(
      decisionParagraphs({
        located: [
          { anchorId: "p-1", start: 0, end: 3, text: "One", type: "paragraph" },
        ],
        text: "One",
      }),
    ).toEqual([{ anchorId: "p-1", text: "One" }]);
  });
});
