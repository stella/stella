/**
 * What a grading batch is sent back for. Each rule names a mistake the
 * documents can prove, so the tests are one proven mistake each, plus the
 * merge that decides which answer survives.
 */

import { describe, expect, test } from "bun:test";

import {
  buildRepairMessage,
  findGradingViolations,
  mergeRepairedFindings,
} from "@/api/lib/document-review/reference-grade-repair";

const TARGET_BLOCK =
  "Nároky musí být oznámeny do 12 (dvanácti) měsíců od dokončení díla, jinak zanikají.";
const STANDARD_BLOCK =
  "Nároky musí být oznámeny do 6 (šesti) měsíců od dokončení díla, jinak zanikají.";

const targetBlocks = new Map([["p-1", TARGET_BLOCK]]);

const position = (sourceId = "pos-1") => ({
  sourceId,
  passages: [{ blockId: "r-9", text: STANDARD_BLOCK }],
});

const emptyDelta = {
  targetValue: null,
  standardValue: null,
  items: [],
};

const finding = (overrides: Record<string, unknown> = {}) => ({
  positionId: "pos-1",
  proposedText: null,
  targetCitations: [{ blockId: "p-1" }],
  delta: emptyDelta,
  ...overrides,
});

const violations = (
  findings: readonly ReturnType<typeof finding>[],
  positions = [position()],
) =>
  findGradingViolations({
    positions,
    findings,
    targetBlocks,
    targetLanguage: "CS",
  });

describe("findGradingViolations", () => {
  test("a batch that checks out has nothing to repair", () => {
    expect(
      violations([
        finding({
          proposedText: STANDARD_BLOCK,
          delta: {
            ...emptyDelta,
            targetValue: { text: "12 (dvanácti) měsíců", blockId: "p-1" },
            standardValue: { text: "6 (šesti) měsíců", blockId: "r-9" },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test("a position without an answer is asked again", () => {
    expect(violations([])).toEqual([
      {
        positionId: "pos-1",
        reasons: ["no answer was given for this position."],
      },
    ]);
  });

  test("a block id the target does not have is named, once", () => {
    const [violation] = violations([
      finding({
        targetCitations: [{ blockId: "p-1" }, { blockId: "p-404" }],
        delta: {
          ...emptyDelta,
          targetValue: { text: "12 (dvanácti) měsíců", blockId: "p-404" },
        },
      }),
    ]);
    expect(violation?.reasons).toEqual([
      "cites p-404, which the target document has no block for; cite only block ids of the target.",
    ]);
  });

  test("a standard value outside the position's passages is named", () => {
    const [violation] = violations([
      finding({
        delta: {
          ...emptyDelta,
          standardValue: { text: "6 (šesti) měsíců", blockId: "r-1" },
        },
      }),
    ]);
    expect(violation?.reasons).toEqual([
      "delta.standardValue cites r-1, which is not one of this position's standard passages.",
    ]);
  });

  test("a term the block does not write that way is a misquote", () => {
    const [violation] = violations([
      finding({
        delta: {
          ...emptyDelta,
          targetValue: { text: "12 měsíců", blockId: "p-1" },
          standardValue: { text: "6 měsíců", blockId: "r-9" },
        },
      }),
    ]);
    expect(violation?.reasons).toEqual([
      "delta.targetValue.text is not written in block p-1 as given; copy the term character for character.",
      "delta.standardValue.text is not written in block r-9 as given; copy the term character for character.",
    ]);
  });

  test("wording in another language names both languages", () => {
    const [violation] = violations([
      finding({
        proposedText:
          "Claims must be notified within 6 months of completion, failing which they lapse.",
      }),
    ]);
    expect(violation?.reasons).toEqual([
      "proposedText is written in British English; the target document is written in Czech. Rewrite it in Czech, keeping the standard's meaning.",
    ]);
  });

  test("only the first answer for a position is checked", () => {
    expect(
      violations([
        finding(),
        finding({ targetCitations: [{ blockId: "p-404" }] }),
      ]),
    ).toEqual([]);
  });
});

describe("buildRepairMessage", () => {
  test("lists each position with its reasons in the model's field names", () => {
    expect(
      buildRepairMessage([
        { positionId: "pos-1", reasons: ["first reason.", "second reason."] },
        {
          positionId: "pos-2",
          reasons: ["no answer was given for this position."],
        },
      ]),
    ).toBe(
      [
        "These answers do not check out against the documents. Answer the positions below again, once each, following the same rules; leave every other position out.",
        "- positionId=pos-1",
        "  - first reason.",
        "  - second reason.",
        "- positionId=pos-2",
        "  - no answer was given for this position.",
      ].join("\n"),
    );
  });
});

describe("mergeRepairedFindings", () => {
  test("a repaired answer replaces the one it corrects and nothing else", () => {
    const merged = mergeRepairedFindings({
      findings: [
        { positionId: "pos-1", mark: "original" },
        { positionId: "pos-2", mark: "original" },
      ],
      repaired: [
        { positionId: "pos-2", mark: "repaired" },
        { positionId: "pos-2", mark: "repaired again" },
        { positionId: "pos-3", mark: "unasked" },
      ],
      violations: [{ positionId: "pos-2", reasons: ["reason."] }],
    });
    expect(merged).toEqual([
      { positionId: "pos-1", mark: "original" },
      { positionId: "pos-2", mark: "repaired" },
    ]);
  });

  test("an answer the repair did not return stays absent", () => {
    expect(
      mergeRepairedFindings({
        findings: [{ positionId: "pos-1" }],
        repaired: [],
        violations: [{ positionId: "pos-1", reasons: ["reason."] }],
      }),
    ).toEqual([]);
  });
});
