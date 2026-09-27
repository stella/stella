import { describe, expect, test } from "bun:test";

import { makeClaim, supported } from "@/features/avt/avt.test-fixtures";
import type { VerificationRun } from "@/features/avt/types";
import {
  groupClaimsIntoPassages,
  passageReadingOrder,
  proseReadingOrder,
  segmentProse,
  segmentProseBlock,
  spanPresentation,
} from "@/features/avt/verification-view.logic";

describe("spanPresentation", () => {
  const cases: {
    matches: boolean;
    filterActive: boolean;
    expected: { dim: boolean; highlight: boolean };
  }[] = [
    {
      matches: false,
      filterActive: false,
      expected: { dim: false, highlight: false },
    },
    {
      matches: true,
      filterActive: false,
      expected: { dim: false, highlight: false },
    },
    {
      matches: false,
      filterActive: true,
      expected: { dim: true, highlight: false },
    },
    {
      matches: true,
      filterActive: true,
      expected: { dim: false, highlight: true },
    },
  ];

  for (const { matches, filterActive, expected } of cases) {
    test(`matches=${String(matches)} filterActive=${String(filterActive)}`, () => {
      expect(spanPresentation({ matches, filterActive })).toEqual(expected);
    });
  }

  test("never dims and highlights the same claim at once", () => {
    for (const matches of [true, false]) {
      for (const filterActive of [true, false]) {
        const { dim, highlight } = spanPresentation({ matches, filterActive });
        expect(dim && highlight).toBe(false);
      }
    }
  });
});

describe("stored statement text", () => {
  const block = {
    ordinal: 0,
    blockId: "p1",
    kind: "docx-block",
    pageNumber: null,
    text: "Before one, between two, after.",
  } satisfies VerificationRun["blocks"][number];
  const claim = (suffix: number, start: number, end: number) =>
    makeClaim({
      suffix,
      verdict: supported(),
      anchor: { type: "docx-block", blockId: "p1", start, end },
    });

  test("keeps every character around claims in document order", () => {
    const segments = segmentProseBlock(block, [
      claim(2, 20, 23),
      claim(1, 7, 10),
    ]);

    expect(segments.map((segment) => segment.text).join("")).toBe(block.text);
    expect(segments.map((segment) => segment.type)).toEqual([
      "plain",
      "claim",
      "plain",
      "claim",
      "plain",
    ]);
    expect(
      segments
        .filter((segment) => segment.type === "claim")
        .map((segment) => segment.claim.id),
    ).toEqual([claim(1, 7, 10).id, claim(2, 20, 23).id]);
  });

  test("uses the earliest and then longest span when claims overlap", () => {
    const segments = segmentProseBlock({ ...block, text: "abcdefghij" }, [
      claim(3, 2, 8),
      claim(2, 0, 5),
      claim(1, 0, 5),
      claim(4, 7, 10),
    ]);

    expect(segments.map((segment) => segment.text).join("")).toBe("abcdefghij");
    expect(
      segments
        .filter((segment) => segment.type === "claim")
        .map((segment) => [segment.claim.id, segment.text]),
    ).toEqual([
      [claim(1, 0, 5).id, "abcde"],
      [claim(3, 2, 8).id, "fgh"],
      [claim(4, 7, 10).id, "ij"],
    ]);
  });

  test("matches PDF claims by page and retains page order", () => {
    const page = (ordinal: number, pageNumber: number, text: string) =>
      ({
        ordinal,
        blockId: `P${pageNumber}`,
        kind: "pdf-page",
        pageNumber,
        text,
      }) satisfies VerificationRun["blocks"][number];
    const onPage = makeClaim({
      suffix: 5,
      verdict: supported(),
      anchor: { type: "pdf-page", pageNumber: 2, start: 1, end: 3 },
    });
    const prose = segmentProse(
      [page(1, 2, "page two"), page(0, 1, "page one")],
      [onPage],
    );

    expect(prose.map((item) => item.pageNumber)).toEqual([1, 2]);
    expect(prose[0]?.segments.map((segment) => segment.text).join("")).toBe(
      "page one",
    );
    expect(proseReadingOrder(prose)).toEqual([onPage.id]);
  });
});

describe("claim passages", () => {
  const inBlock = (suffix: number, blockId: string, start: number) =>
    makeClaim({
      suffix,
      verdict: supported(),
      anchor: { type: "docx-block", blockId, start, end: start + 5 },
    });

  test("keep consecutive claims of one block together, ordered by offset", () => {
    const passages = groupClaimsIntoPassages([
      inBlock(1, "p1", 40),
      inBlock(2, "p1", 0),
      inBlock(3, "p2", 0),
    ]);

    expect(
      passages.map((passage) => passage.claims.map((c) => c.text)),
    ).toEqual([["Claim 2", "Claim 1"], ["Claim 3"]]);
  });

  test("follow reading order, so a block revisited later is a new passage", () => {
    const passages = groupClaimsIntoPassages([
      inBlock(3, "p1", 20),
      inBlock(1, "p1", 0),
      inBlock(2, "p2", 0),
    ]);

    expect(passages).toHaveLength(3);
    expect(new Set(passages.map((passage) => passage.key)).size).toBe(3);
  });

  test("carry the PDF page a passage is on", () => {
    const passages = groupClaimsIntoPassages([
      makeClaim({
        suffix: 1,
        verdict: supported(),
        anchor: { type: "pdf-page", pageNumber: 4, start: 0, end: 5 },
      }),
    ]);

    expect(passages.at(0)?.pageNumber).toBe(4);
  });

  test("lose no claim and show each once", () => {
    const claims = [
      inBlock(1, "p1", 0),
      inBlock(2, "p2", 0),
      inBlock(3, "p1", 3),
      inBlock(4, "p1", 1),
    ];

    const order = passageReadingOrder(groupClaimsIntoPassages(claims));

    expect(order.toSorted()).toEqual(
      claims.map((claim) => claim.id).toSorted(),
    );
  });
});
