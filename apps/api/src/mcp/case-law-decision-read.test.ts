import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import type { DecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { RankedRelatedDecision } from "@/api/handlers/case-law/decisions/citation-graph";
import {
  brandPersistedCaseLawCitationId,
  brandPersistedCaseLawDecisionId,
} from "@/api/lib/safe-id-boundaries";
import { locateDecisionBlocks } from "@/api/mcp/case-law-decision-outline";
import {
  citationSummaryOutput,
  compactDecisionMetadata,
  decisionTextAllowances,
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

test("decision text allowances give unused shares only to documents they complete, in input order", () => {
  expect(decisionTextAllowances([100, 1, 100], 90)).toEqual([30, 1, 30]);
  expect(decisionTextAllowances([50, 1, 100], 90)).toEqual([50, 1, 30]);
  expect(decisionTextAllowances([40, 40, 1], 90)).toEqual([40, 40, 1]);
  // Two documents compete for the same remainder: the earlier one wins.
  expect(decisionTextAllowances([50, 1, 50], 90)).toEqual([50, 1, 30]);
});

test("decision text allowances keep a truncated document on the even share", () => {
  assertProperty(
    "decision text allowances keep a truncated document on the even share",
    fc.property(
      fc.array(fc.integer({ min: 0, max: 100_000 }), {
        minLength: 1,
        maxLength: 50,
      }),
      fc.integer({ min: 1, max: 200_000 }),
      (lengths, cap) => {
        const allowances = decisionTextAllowances(lengths, cap);
        expect(allowances).toEqual(decisionTextAllowances(lengths, cap));
        expect(
          allowances.reduce((sum, value) => sum + value, 0),
        ).toBeLessThanOrEqual(cap);
        expect(
          allowances.every((value, index) => value <= (lengths[index] ?? 0)),
        ).toBe(true);
        // A truncated document's window depends only on the cap and the batch
        // size, so its continuation pages stay aligned when siblings change.
        const share = Math.floor(cap / lengths.length);
        for (const [index, value] of allowances.entries()) {
          if (value < (lengths[index] ?? 0)) {
            expect(value).toBe(share);
          }
        }
      },
    ),
  );
});

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
      { citation: "sp. zn. 29 Odo 1/2001" },
      { citation: "29 Odo 1/2001" },
      {
        caseNumber: "5 Cdo 5/2020",
        decisionId: decisionId(5),
        url: "https://app.test/law/ns-5",
      },
    ]);
    expect(summary.cites.more).toBe(true);
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

  test("query matches retain court numbering independently of parser anchors", () => {
    const found = paragraphsMatching({
      budget: 8000,
      language: "cs",
      paragraphs: decisionParagraphs({
        located: [
          {
            type: "paragraph",
            anchorId: "p-1",
            number: 48,
            start: 0,
            end: 6,
            text: "Nájem.",
            headingPath: [],
            label: "48",
          },
        ],
        text: "Nájem.",
      }),
      query: "nájem",
    });
    expect(found.paragraphs).toEqual([
      {
        anchorId: "p-1",
        number: 48,
        text: "Nájem.",
        position: 1,
        label: "48",
        headingPath: [],
        hit: true,
      },
    ]);
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
      found.paragraphs.map(({ position, hit }) => [position, hit]),
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
      found.paragraphs.filter(({ hit }) => hit).map(({ position }) => position),
    ).toEqual([4]);
  });

  test("overlapping neighbourhoods are not repeated", () => {
    const found = paragraphsMatching({
      budget: 8000,
      language: "xx",
      paragraphs: decisionParagraphs({ located: null, text: "a x\nb x\nc x" }),
      query: "x",
    });
    expect(found.paragraphs.map(({ position }) => position)).toEqual([1, 2, 3]);
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
        { anchorId: null, headingPath: [], label: null, text: long("before") },
        { anchorId: null, headingPath: [], label: null, text: long("match") },
        { anchorId: null, headingPath: [], label: null, text: long("after") },
      ],
      query: "match",
    });
    expect(
      found.paragraphs.reduce((sum, { text }) => sum + text.length, 0),
    ).toBeLessThanOrEqual(8000);
    expect(found.paragraphs.map(({ position }) => position)).toEqual([2]);
    expect(found.truncated).toBe(true);
  });

  test("a neighbour that fits what is left still travels", () => {
    const found = paragraphsMatching({
      budget: 20,
      language: "xx",
      paragraphs: [
        { anchorId: null, headingPath: [], label: null, text: "short" },
        { anchorId: null, headingPath: [], label: null, text: "match here" },
        {
          anchorId: null,
          headingPath: [],
          label: null,
          text: "much too long to fit",
        },
      ],
      query: "match",
    });
    expect(found.paragraphs.map(({ position }) => position)).toEqual([1, 2]);
    expect(found.truncated).toBe(true);
  });

  test("a paragraph longer than the budget is cut to it", () => {
    const found = paragraphsMatching({
      budget: 5,
      language: "xx",
      paragraphs: [
        {
          anchorId: "p-1",
          headingPath: [],
          label: null,
          text: "match and much more text",
        },
      ],
      query: "match",
    });
    expect(found.paragraphs).toEqual([
      {
        anchorId: "p-1",
        headingPath: [],
        label: null,
        text: "match",
        position: 1,
        hit: true,
      },
    ]);
  });

  test("blocks keep their fragments", () => {
    expect(
      decisionParagraphs({
        located: [
          {
            anchorId: "p-1",
            headingPath: [],
            label: null,
            start: 0,
            end: 3,
            text: "One",
            type: "paragraph",
          },
        ],
        text: "One",
      }),
    ).toEqual([{ anchorId: "p-1", headingPath: [], label: null, text: "One" }]);
  });
});

test("query hits and neighbours carry only their enclosing AST headings and publisher labels", () => {
  const blocks = [
    {
      type: "paragraph",
      anchorId: "p-0",
      id: "p-0",
      inlines: [],
      plainText: "Unsectioned",
    },
    {
      type: "heading",
      anchorId: "h-1",
      id: "h-1",
      inlines: [],
      plainText: "II. Posouzení věci",
      level: 1,
    },
    {
      type: "paragraph",
      anchorId: "p-1",
      id: "p-1",
      inlines: [],
      plainText: "23. Majority",
      number: 42,
    },
    {
      type: "heading",
      anchorId: "h-2",
      id: "h-2",
      inlines: [],
      plainText: "Odlišné stanovisko soudce X",
      level: 2,
    },
    {
      type: "paragraph",
      anchorId: "p-2",
      id: "p-2",
      inlines: [],
      plainText: "[007] dissent match",
      role: "dissent",
    },
    {
      type: "paragraph",
      anchorId: "p-3",
      id: "p-3",
      inlines: [],
      plainText: "24. dissent neighbour",
    },
    {
      type: "heading",
      anchorId: "h-3",
      id: "h-3",
      inlines: [],
      plainText: "III. Závěr",
      level: 1,
    },
    {
      type: "paragraph",
      anchorId: "p-4",
      id: "p-4",
      inlines: [],
      plainText: "No printed label",
    },
  ] satisfies Block[];
  const text = blocks.map(({ plainText }) => plainText).join("\n");
  const paragraphs = decisionParagraphs({
    located: locateDecisionBlocks(blocks, text),
    text,
  });
  expect(paragraphs.map(({ headingPath }) => headingPath)).toEqual([
    [],
    [],
    ["II. Posouzení věci"],
    ["II. Posouzení věci"],
    ["II. Posouzení věci", "Odlišné stanovisko soudce X"],
    ["II. Posouzení věci", "Odlišné stanovisko soudce X"],
    [],
    ["III. Závěr"],
  ]);
  expect(paragraphs.map(({ label }) => label)).toEqual([
    null,
    null,
    "42",
    null,
    "007",
    "24",
    null,
    null,
  ]);
  const found = paragraphsMatching({
    budget: 8000,
    language: "xx",
    paragraphs,
    query: "match",
  });
  expect(found.paragraphs).toEqual([
    {
      anchorId: "h-2",
      headingPath: ["II. Posouzení věci"],
      label: null,
      text: "Odlišné stanovisko soudce X",
      position: 4,
      hit: false,
    },
    {
      anchorId: "p-2",
      headingPath: ["II. Posouzení věci", "Odlišné stanovisko soudce X"],
      label: "007",
      text: "[007] dissent match",
      position: 5,
      hit: true,
    },
    {
      anchorId: "p-3",
      headingPath: ["II. Posouzení věci", "Odlišné stanovisko soudce X"],
      label: "24",
      text: "24. dissent neighbour",
      position: 6,
      hit: false,
    },
  ]);
});

test("plain-text passages keep publisher labels separate from their positions without inferred headings", () => {
  const paragraphs = decisionParagraphs({
    located: null,
    text: "\n[23] match\n004. match\n23.match\nIV. match\nmatch [25]\n",
  });
  const found = paragraphsMatching({
    budget: 8000,
    language: "xx",
    paragraphs,
    query: "match",
  });
  expect(
    found.paragraphs.map(({ position, label, headingPath }) => ({
      position,
      label,
      headingPath,
    })),
  ).toEqual([
    { position: 1, label: "23", headingPath: [] },
    { position: 2, label: "004", headingPath: [] },
    { position: 3, label: null, headingPath: [] },
    { position: 4, label: null, headingPath: [] },
    { position: 5, label: null, headingPath: [] },
  ]);
});
