/**
 * A verification limited to a range of a document's paragraphs, as the web
 * reads it: what a reviewer types into the run-start control, and what the
 * stored scope says was checked. The range grammar (`82-136`, `82–136`,
 * `14`) is the one the API parses (`parseDecisionParagraphRange`).
 */

import { Result } from "better-result";

import {
  formatDecisionParagraphRange,
  parseDecisionParagraphRange,
} from "@stll/api-contract/decision-paragraph-range";
import type { DecisionParagraphRangeErrorReason } from "@stll/api-contract/decision-paragraph-range";

import type { VerificationRun } from "@/features/avt/types";

export type VerificationScope = VerificationRun["scope"];
export type ParagraphScope = Extract<VerificationScope, { kind: "paragraphs" }>;

export type ParagraphRangeInput =
  | { type: "empty" }
  /** `paragraphs` is the range as the API takes it. */
  | { type: "valid"; paragraphs: string }
  | { type: "invalid"; reason: DecisionParagraphRangeErrorReason };

/** Read the run-start input; spaces around the range and its dash are
 *  allowed, a space inside a number (`1 2-13`) is not: dropping it would
 *  check other paragraphs than the reviewer typed. */
export const readParagraphRangeInput = (input: string): ParagraphRangeInput => {
  const compact = input.trim().replaceAll(/\s+(?=\D)|(?<=\D)\s+/gu, "");
  if (compact === "") {
    return { type: "empty" };
  }
  const parsed = parseDecisionParagraphRange(compact);
  return Result.isError(parsed)
    ? { type: "invalid", reason: parsed.error.reason }
    : {
        type: "valid",
        paragraphs: formatDecisionParagraphRange(parsed.value),
      };
};

/** The range as it reads in the run header: `82–136`, or `14` alone. */
export const paragraphRangeLabel = ({
  from,
  to,
}: Pick<ParagraphScope, "from" | "to">): string =>
  from === to ? String(from) : `${String(from)}–${String(to)}`;

/** The paragraph range as the API takes it, to verify the same range again. */
export const scopeParagraphs = (scope: VerificationScope): string | null =>
  scope.kind === "paragraphs" ? formatDecisionParagraphRange(scope) : null;

type StoredBlock = VerificationRun["blocks"][number];

/** The part of a stored block outside the run's range, as text offsets:
 *  before the range in its first block, after it in its last. */
export type OutsideSpan = { start: number; end: number };

/**
 * Where the stored text falls outside the range: a scoped run stores only
 * the blocks its range spans, so only the first block's text before the
 * range and the last block's text after it are outside.
 */
export const outsideSpansForBlock = (
  scope: VerificationScope,
  block: Pick<StoredBlock, "blockId" | "text">,
): OutsideSpan[] => {
  if (scope.kind === "whole") {
    return [];
  }
  const spans: OutsideSpan[] = [];
  if (block.blockId === scope.start.blockId && scope.start.offset > 0) {
    spans.push({ start: 0, end: scope.start.offset });
  }
  if (
    block.blockId === scope.end.blockId &&
    scope.end.offset < block.text.length
  ) {
    spans.push({ start: scope.end.offset, end: block.text.length });
  }
  return spans;
};
