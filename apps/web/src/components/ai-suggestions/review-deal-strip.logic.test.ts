import { describe, expect, test } from "bun:test";

import {
  buildDealStrip,
  dealStripSegmentLabel,
} from "@/components/ai-suggestions/review-deal-strip.logic";
import type {
  DealStripBlock,
  DealStripFinding,
} from "@/components/ai-suggestions/review-deal-strip.logic";

const body = (id: string, text = "Body text"): DealStripBlock => ({
  id,
  headingLevel: null,
  displayLabel: null,
  text,
});

const heading = (
  id: string,
  text: string,
  {
    level = 1,
    displayLabel = null,
  }: { level?: number; displayLabel?: string | null } = {},
): DealStripBlock => ({
  id,
  headingLevel: level,
  displayLabel,
  text,
});

const finding = (
  id: string,
  blockId: string | null,
  { accent = false, title = "Notice period" } = {},
): DealStripFinding => ({ id, title, blockId, accent });

describe("dealStripSegmentLabel", () => {
  test("uses the list marker folio resolved for a numbered heading", () => {
    expect(
      dealStripSegmentLabel(
        heading("h1", "Definitions", { displayLabel: "4." }),
      ),
    ).toBe("4. Definitions");
  });

  test("ignores a heading style id, which is not a clause number", () => {
    expect(
      dealStripSegmentLabel(
        heading("h1", "Definitions", { displayLabel: "Heading2" }),
      ),
    ).toBe("Definitions");
  });

  test("writes a hand-typed clause number once", () => {
    expect(dealStripSegmentLabel(heading("h1", "4.2 Termination"))).toBe(
      "4.2 Termination",
    );
  });

  test("falls back to the whole document when a heading has no text", () => {
    expect(dealStripSegmentLabel(heading("h1", "   "))).toBe("Document");
  });
});

describe("buildDealStrip", () => {
  test("segments at the shallowest heading depth the document uses", () => {
    const blocks = [
      body("b0"),
      heading("h1", "Term", { level: 2 }),
      body("b1"),
      heading("h2", "Scope", { level: 3 }),
      body("b2"),
      heading("h3", "Termination", { level: 2 }),
      body("b3"),
    ];
    const { segments } = buildDealStrip({ blocks, findings: [] });
    expect(segments.map((segment) => segment.label)).toEqual([
      "Preamble",
      "Term",
      "Termination",
    ]);
    expect(segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 1 / 7],
      [1 / 7, 5 / 7],
      [5 / 7, 1],
    ]);
  });

  test("a document with no headings is one segment", () => {
    const { segments } = buildDealStrip({
      blocks: [body("b0"), body("b1")],
      findings: [],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.label).toBe("Document");
    expect(segments[0]?.start).toBe(0);
    expect(segments[0]?.end).toBe(1);
  });

  test("a document opening on a heading gets no preamble segment", () => {
    const { segments } = buildDealStrip({
      blocks: [heading("h1", "Term"), body("b1")],
      findings: [],
    });
    expect(segments.map((segment) => segment.label)).toEqual(["Term"]);
  });

  test("places each mark in the clause its cited block belongs to", () => {
    const blocks = [
      heading("h1", "Term"),
      body("b1"),
      heading("h2", "Termination"),
      body("b2"),
    ];
    const { segments, unplacedFindingIds } = buildDealStrip({
      blocks,
      findings: [finding("f1", "b1"), finding("f2", "b2", { accent: true })],
    });
    expect(unplacedFindingIds).toEqual([]);
    expect(segments[0]?.marks.map((mark) => mark.findingId)).toEqual(["f1"]);
    expect(segments[1]?.marks.map((mark) => mark.findingId)).toEqual(["f2"]);
    expect(segments[0]?.marks[0]?.offset).toBe(1.5 / 4);
    expect(segments[1]?.marks[0]?.accent).toBe(true);
  });

  test("density compares a clause against the busiest one", () => {
    const blocks = [
      heading("h1", "Term"),
      body("b1"),
      body("b2"),
      heading("h2", "Termination"),
      body("b3"),
    ];
    const { segments } = buildDealStrip({
      blocks,
      findings: [finding("f1", "b1"), finding("f2", "b2"), finding("f3", "b3")],
    });
    expect(segments[0]?.density).toBe(1);
    expect(segments[1]?.density).toBe(0.5);
  });

  test("density is zero for a run that flagged nothing", () => {
    const { segments } = buildDealStrip({
      blocks: [heading("h1", "Term"), body("b1")],
      findings: [],
    });
    expect(segments[0]?.density).toBe(0);
  });

  test("a finding citing nothing, or a clause since edited away, is unplaced", () => {
    const { segments, unplacedFindingIds } = buildDealStrip({
      blocks: [heading("h1", "Term"), body("b1")],
      findings: [
        finding("f1", null),
        finding("f2", "gone"),
        finding("f3", "b1"),
      ],
    });
    expect(unplacedFindingIds).toEqual(["f1", "f2"]);
    expect(segments[0]?.marks.map((mark) => mark.findingId)).toEqual(["f3"]);
  });

  test("an unread document places nothing", () => {
    const { segments, unplacedFindingIds } = buildDealStrip({
      blocks: [],
      findings: [finding("f1", "b1")],
    });
    expect(segments).toEqual([]);
    expect(unplacedFindingIds).toEqual(["f1"]);
  });
});
