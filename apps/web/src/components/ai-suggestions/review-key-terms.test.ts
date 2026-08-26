import { describe, expect, test } from "bun:test";

import {
  buildMarkedPair,
  DIFF_LENGTH_LIMIT,
  diffHighlightRanges,
  KEY_TERM_KIND,
  keyTermRanges,
  type KeyTermKind,
  type MarkedSegment,
  phraseRanges,
  resolveMarkedSegments,
  splitClauseLabel,
} from "@/components/ai-suggestions/review-key-terms";

/** The substrings a set of ranges covers, in source order. */
const marked = (text: string, kind: KeyTermKind) =>
  resolveMarkedSegments({ ranges: keyTermRanges(text), text })
    .filter((segment) => segment.kind === kind)
    .map((segment) => segment.text);

const segmentTexts = (segments: readonly MarkedSegment[], kind: KeyTermKind) =>
  segments
    .filter((segment) => segment.kind === kind)
    .map((segment) => segment.text);

describe("splitClauseLabel", () => {
  test("lifts a leading clause number out of the block text", () => {
    expect(splitClauseLabel("2.1 The Seller shall deliver.")).toEqual({
      body: "The Seller shall deliver.",
      label: "2.1",
    });
    expect(splitClauseLabel("13.18. Notices")).toEqual({
      body: "Notices",
      label: "13.18.",
    });
    expect(splitClauseLabel("(a) each Party;")).toEqual({
      body: "each Party;",
      label: "(a)",
    });
    expect(splitClauseLabel("b) druhá strana")).toEqual({
      body: "druhá strana",
      label: "b)",
    });
  });

  test("leaves a block with no clause number unlabelled", () => {
    expect(splitClauseLabel("The Seller shall deliver.")).toEqual({
      body: "The Seller shall deliver.",
      label: null,
    });
  });

  test("does not mistake a leading quantity for a clause number", () => {
    expect(splitClauseLabel("12 (twelve) months from Completion")).toEqual({
      body: "12 (twelve) months from Completion",
      label: null,
    });
    expect(splitClauseLabel("1.5 million EUR")).toEqual({
      body: "1.5 million EUR",
      label: null,
    });
  });
});

describe("keyTermRanges", () => {
  test("marks a figure with its spelled-out repeat and unit", () => {
    expect(marked("within 12 (twelve) months of Completion", "term")).toContain(
      "12 (twelve) months",
    );
  });

  test("marks amounts, placeholders, and percentages", () => {
    expect(marked("a price of PLN 1", "term")).toContain("PLN 1");
    expect(marked("interest of [●]% per annum", "term")).toContain("[●]%");
    expect(marked("a cap of 1 000 000 EUR", "term")).toContain("1 000 000 EUR");
  });

  test("marks a date however it is written", () => {
    expect(marked("no later than 30 June 2025", "term")).toContain(
      "30 June 2025",
    );
    expect(marked("nejpozději do 30. 6. 2025", "term")).toContain(
      "30. 6. 2025",
    );
  });

  test("reads Czech and Polish durations", () => {
    expect(marked("ve lhůtě 30 (třiceti) dnů", "term")).toContain(
      "30 (třiceti) dnů",
    );
    expect(marked("w terminie 14 dni roboczych", "term")).toContain(
      "14 dni roboczych",
    );
    expect(marked("do 6 miesięcy", "term")).toContain("6 miesięcy");
  });

  test("marks a multi-word defined term", () => {
    expect(marked("the Confidential Information disclosed", "term")).toContain(
      "Confidential Information",
    );
  });

  test("marks a single capitalised word only where it is being defined", () => {
    expect(marked('"Leakage" means any payment', "term")).toContain("Leakage");
    expect(marked("the Leakage described above", "term")).not.toContain(
      "Leakage",
    );
  });

  test("leaves a bare clause number alone", () => {
    expect(marked("as set out in clause 2.1 above", "term")).toEqual([]);
  });

  test("does not mark an all-caps heading as a defined term", () => {
    expect(marked("LIMITATION OF LIABILITY", "term")).toEqual([]);
  });
});

describe("diffHighlightRanges", () => {
  test("marks the differing run on each side, without redline", () => {
    const { standard, target } = diffHighlightRanges({
      standardText: "within twelve months of Completion",
      targetText: "within six months of Completion",
    });
    expect(
      standard.map((range) =>
        "within twelve months of Completion".slice(range.start, range.end),
      ),
    ).toEqual(["twelve"]);
    expect(
      target.map((range) =>
        "within six months of Completion".slice(range.start, range.end),
      ),
    ).toEqual(["six"]);
  });

  test("merges adjacent changed tokens into one run", () => {
    const targetText = "notice in writing and by email";
    const { target } = diffHighlightRanges({
      standardText: "notice in writing",
      targetText,
    });
    expect(
      target.map((range) => targetText.slice(range.start, range.end)),
    ).toEqual(["and by email"]);
  });

  test("ignores a run that is only punctuation or spacing", () => {
    const { standard, target } = diffHighlightRanges({
      standardText: "the Seller shall deliver",
      targetText: "the Seller shall deliver ,",
    });
    expect(standard).toEqual([]);
    expect(target).toEqual([]);
  });

  test("gives up on a pair too long to diff without a quadratic table", () => {
    const sentence = "the Seller shall deliver the Shares ";
    const long = sentence.repeat(
      Math.ceil((DIFF_LENGTH_LIMIT + 1) / sentence.length),
    );
    expect(
      diffHighlightRanges({
        standardText: long,
        targetText: `${long}and pay the Price`,
      }),
    ).toEqual({ standard: [], target: [] });
  });

  test("gives up once nearly everything differs", () => {
    expect(
      diffHighlightRanges({
        standardText: "each Party shall bear its own costs",
        targetText: "the Buyer indemnifies the Seller in full",
      }),
    ).toEqual({ standard: [], target: [] });
  });
});

describe("phraseRanges", () => {
  test("finds the phrase across whatever whitespace the block used", () => {
    const text = "a period of 12 (twelve)\nmonths";
    expect(
      phraseRanges(text, "12 (twelve) months").map((range) =>
        text.slice(range.start, range.end),
      ),
    ).toEqual(["12 (twelve)\nmonths"]);
  });

  test("an empty phrase matches nothing", () => {
    expect(phraseRanges("anything", "   ")).toEqual([]);
  });
});

describe("resolveMarkedSegments", () => {
  test("reconstructs the text exactly", () => {
    const text = "within 12 (twelve) months of Completion";
    expect(
      resolveMarkedSegments({ ranges: keyTermRanges(text), text })
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });

  test("the stronger mark wins where two overlap", () => {
    const text = "within 12 (twelve) months";
    const segments = resolveMarkedSegments({
      ranges: [...keyTermRanges(text), ...phraseRanges(text, "12 (twelve)")],
      text,
    });
    expect(segmentTexts(segments, KEY_TERM_KIND.delta)).toEqual([
      "12 (twelve)",
    ]);
    expect(segmentTexts(segments, KEY_TERM_KIND.term)).toEqual([" months"]);
  });
});

describe("buildMarkedPair", () => {
  test("joins consecutive blocks and marks both sides", () => {
    const { standard, target } = buildMarkedPair({
      standard: [
        { blockId: "s1", text: "13.18 The Seller shall give notice." },
        { blockId: "s2", text: "Notice takes effect within twelve months." },
      ],
      target: [
        { blockId: "t1", text: "2.1 The Seller shall give notice." },
        { blockId: "t2", text: "Notice takes effect within six months." },
      ],
    });

    expect(target.map((paragraph) => paragraph.label)).toEqual(["2.1", null]);
    expect(standard.map((paragraph) => paragraph.label)).toEqual([
      "13.18",
      null,
    ]);
    expect(target.map((paragraph) => paragraph.blockId)).toEqual(["t1", "t2"]);

    const changedTarget = target.at(1)?.segments ?? [];
    const changedStandard = standard.at(1)?.segments ?? [];
    expect(segmentTexts(changedTarget, KEY_TERM_KIND.diff)).toEqual(["six"]);
    expect(segmentTexts(changedStandard, KEY_TERM_KIND.diff)).toEqual([
      "twelve",
    ]);
  });

  test("a parameter delta claims its own phrase on each side", () => {
    const { standard, target } = buildMarkedPair({
      deltaStandardText: "24 months",
      deltaTargetText: "12 months",
      standard: [{ blockId: "s1", text: "The term is 24 months." }],
      target: [{ blockId: "t1", text: "The term is 12 months." }],
    });
    expect(segmentTexts(target.at(0)?.segments ?? [], "delta")).toEqual([
      "12 months",
    ]);
    expect(segmentTexts(standard.at(0)?.segments ?? [], "delta")).toEqual([
      "24 months",
    ]);
    // The generic quantity mark does not also claim the delta's span.
    expect(segmentTexts(target.at(0)?.segments ?? [], "term")).toEqual([]);
  });

  test("every side reconstructs its own block text", () => {
    const passages = [
      { blockId: "t1", text: "2.1 Cena činí 1 000 000 Kč." },
      { blockId: "t2", text: "Splatnost je 30 (třiceti) dnů." },
    ];
    const { target } = buildMarkedPair({ standard: [], target: passages });
    expect(
      target.map((paragraph) =>
        paragraph.segments.map((segment) => segment.text).join(""),
      ),
    ).toEqual(["Cena činí 1 000 000 Kč.", "Splatnost je 30 (třiceti) dnů."]);
  });
});
