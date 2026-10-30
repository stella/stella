import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createFolioAIEditSnapshot } from "@stll/folio-core/ai-edits";
import { schema } from "@stll/folio-core/prosemirror";

import {
  claimId,
  makeClaim,
  supported,
} from "@/features/avt/avt.test-fixtures";
import {
  claimAtPoint,
  claimHighlightName,
  locateClaimsInDocument,
  paintedSegments,
} from "@/features/avt/original-docx.logic";
import type { VerificationRun } from "@/features/avt/types";

const bold =
  schema.marks["bold"] ?? panic("Expected the Folio schema to define bold.");

const doc = schema.node("doc", undefined, [
  schema.node("paragraph", { paraId: "1A2B3C4D" }, [
    schema.text("The lease was signed on "),
    schema.text("3 March 2021", [bold.create()]),
    schema.text(" by both parties."),
  ]),
  schema.node("paragraph", { paraId: "5E6F7A8B" }, [
    schema.text("Rent fell due monthly."),
  ]),
]);

/** The blocks a run stores, read the way the server reads them. */
const storedBlocks = (): VerificationRun["blocks"] =>
  createFolioAIEditSnapshot(doc)
    .blocks.filter((block) => block.text.trim().length > 0)
    .map((block, ordinal): VerificationRun["blocks"][number] => ({
      ordinal,
      blockId: block.id,
      kind: "docx-block",
      pageNumber: null,
      text: block.text,
    }));

const docxClaim = (
  suffix: number,
  blockId: string,
  start: number,
  end: number,
) =>
  makeClaim({
    suffix,
    verdict: supported(),
    anchor: { type: "docx-block", blockId, start, end },
  });

describe("locateClaimsInDocument", () => {
  const blocks = storedBlocks();
  const [first, second] = blocks;

  test("the server's blocks are the snapshot's paragraphs", () => {
    expect(blocks.map((block) => block.text)).toEqual([
      "The lease was signed on 3 March 2021 by both parties.",
      "Rent fell due monthly.",
    ]);
  });

  test("maps block offsets onto the document's own words, across runs", () => {
    const blockId = first?.blockId ?? "";
    const text = first?.text ?? "";
    const start = text.indexOf("signed");
    const end = text.indexOf(" by both");
    const claim = docxClaim(1, blockId, start, end);

    const { located, unlocated } = locateClaimsInDocument({
      doc,
      blocks,
      claims: [claim],
    });

    expect(unlocated).toEqual([]);
    const range = located.at(0);
    expect(range).toMatchObject({ claimId: claim.id, blockId });
    expect(doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe(
      "signed on 3 March 2021",
    );
  });

  test("maps a claim in a later block", () => {
    const blockId = second?.blockId ?? "";
    const claim = docxClaim(2, blockId, 0, 4);

    const { located } = locateClaimsInDocument({
      doc,
      blocks,
      claims: [claim],
    });

    const range = located.at(0);
    expect(doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe("Rent");
  });

  test("reports a claim whose block the original does not have", () => {
    const claim = docxClaim(3, "DEADBEEF", 0, 4);

    expect(locateClaimsInDocument({ doc, blocks, claims: [claim] })).toEqual({
      located: [],
      unlocated: [claim.id],
    });
  });

  test("reports a claim whose stored words differ from the original's", () => {
    const blockId = first?.blockId ?? "";
    const claim = docxClaim(4, blockId, 4, 9);
    // The run read another text for this block than the file now holds.
    const drifted = blocks.map((block) =>
      block.blockId === blockId
        ? { ...block, text: "The house was signed on 3 March 2021." }
        : block,
    );

    expect(
      locateClaimsInDocument({ doc, blocks: drifted, claims: [claim] }),
    ).toEqual({ located: [], unlocated: [claim.id] });
  });

  test("reports offsets past the block's end and a page anchor", () => {
    const blockId = second?.blockId ?? "";
    const pastEnd = docxClaim(5, blockId, 10, 400);
    const onPage = makeClaim({
      suffix: 6,
      verdict: supported(),
      anchor: { type: "pdf-page", pageNumber: 1, start: 0, end: 4 },
    });

    expect(
      locateClaimsInDocument({ doc, blocks, claims: [onPage, pastEnd] }),
    ).toEqual({ located: [], unlocated: [pastEnd.id, onPage.id] });
  });
});

describe("paintedSegments", () => {
  const spans = [
    { pmStart: 1, pmEnd: 25 },
    { pmStart: 25, pmEnd: 37 },
    { pmStart: 37, pmEnd: 54 },
  ];

  test("cuts a range into the runs it crosses, in run offsets", () => {
    expect(paintedSegments(spans, { from: 15, to: 40 })).toEqual([
      { spanIndex: 0, start: 14, end: 24 },
      { spanIndex: 1, start: 0, end: 12 },
      { spanIndex: 2, start: 0, end: 3 },
    ]);
  });

  test("skips runs the range only touches", () => {
    expect(paintedSegments(spans, { from: 25, to: 37 })).toEqual([
      { spanIndex: 1, start: 0, end: 12 },
    ]);
  });

  test("a range on no painted run has no segments", () => {
    expect(paintedSegments(spans, { from: 60, to: 70 })).toEqual([]);
  });
});

describe("claimAtPoint", () => {
  const wide = claimId(1);
  const narrow = claimId(2);
  const boxes = new Map([
    [wide, [{ left: 0, top: 0, right: 200, bottom: 20 }]],
    [narrow, [{ left: 50, top: 0, right: 80, bottom: 20 }]],
  ]);

  test("picks the smallest mark under the point", () => {
    expect(claimAtPoint(boxes, { x: 60, y: 10 })).toBe(narrow);
    expect(claimAtPoint(boxes, { x: 10, y: 10 })).toBe(wide);
  });

  test("is null off every mark", () => {
    expect(claimAtPoint(boxes, { x: 10, y: 40 })).toBeNull();
  });
});

test("highlight names are CSS identifiers", () => {
  expect(claimHighlightName("run:1/a", "supported", "active")).toBe(
    "stella-avt-claim-run_1_a-supported-active",
  );
});
