/**
 * The second look a grading batch gets when an answer does not check out.
 *
 * Every rule here names a mistake the documents can prove: a position left
 * unanswered, a block id the target does not have, a term not written the way
 * its block writes it, wording in a language the target is not in. The model
 * is shown its own batch with those answers named and asked to correct only
 * them. One round: whatever still fails is dropped by normalization the way
 * it always was, and a repair never repairs a repair.
 *
 * Structural input types rather than the grading schema's own, so this module
 * sits under `reference-grade` without importing from it; the call site's
 * findings must still satisfy them, so a schema change that removes a field
 * read here fails to compile.
 */

import {
  languageDisplayName,
  foreignLanguageOf,
} from "@/api/lib/document-review/target-language";
import type { ReviewTargetLanguage } from "@/api/lib/document-review/target-language";

type RepairablePosition = {
  sourceId: string;
  passages: readonly { blockId: string; text: string }[];
};

type RepairableValue = { text: string; blockId: string } | null;

type RepairableFinding = {
  positionId: string;
  proposedText: string | null;
  targetCitations: readonly { blockId: string }[];
  delta: {
    targetValue: RepairableValue;
    standardValue: RepairableValue;
    items: readonly { blockId: string | null }[];
  };
};

export type GradingViolation = { positionId: string; reasons: string[] };

type FindGradingViolationsArgs = {
  positions: readonly RepairablePosition[];
  findings: readonly RepairableFinding[];
  targetBlocks: ReadonlyMap<string, string>;
  targetLanguage: ReviewTargetLanguage;
};

/** Every block id the finding claims the target has. */
const citedTargetBlockIds = (finding: RepairableFinding): string[] => {
  const ids = finding.targetCitations.map(({ blockId }) => blockId);
  if (finding.delta.targetValue !== null) {
    ids.push(finding.delta.targetValue.blockId);
  }
  for (const { blockId } of finding.delta.items) {
    if (blockId !== null) {
      ids.push(blockId);
    }
  }
  return ids;
};

/** A term must be written exactly as its block writes it, or no fix can find
 *  it. A missing block is reported as such, not as a misquoted term. */
const misquotedTerm = (
  field: string,
  value: RepairableValue,
  blocks: ReadonlyMap<string, string>,
): string | null => {
  if (value === null) {
    return null;
  }
  const block = blocks.get(value.blockId);
  if (block === undefined || block.includes(value.text.trim())) {
    return null;
  }
  return `${field}.text is not written in block ${value.blockId} as given; copy the term character for character.`;
};

const findingViolations = (
  finding: RepairableFinding,
  position: RepairablePosition,
  { targetBlocks, targetLanguage }: FindGradingViolationsArgs,
): string[] => {
  const reasons: string[] = [];

  const unknownTargetIds = [
    ...new Set(
      citedTargetBlockIds(finding).filter((id) => !targetBlocks.has(id)),
    ),
  ];
  if (unknownTargetIds.length > 0) {
    reasons.push(
      `cites ${unknownTargetIds.join(", ")}, which the target document has no block for; cite only block ids of the target.`,
    );
  }

  const standardBlocks = new Map(
    position.passages.map(({ blockId, text }) => [blockId, text]),
  );
  const standardValue = finding.delta.standardValue;
  if (standardValue !== null && !standardBlocks.has(standardValue.blockId)) {
    reasons.push(
      `delta.standardValue cites ${standardValue.blockId}, which is not one of this position's standard passages.`,
    );
  }

  const targetTerm = misquotedTerm(
    "delta.targetValue",
    finding.delta.targetValue,
    targetBlocks,
  );
  if (targetTerm !== null) {
    reasons.push(targetTerm);
  }
  const standardTerm = misquotedTerm(
    "delta.standardValue",
    standardValue,
    standardBlocks,
  );
  if (standardTerm !== null) {
    reasons.push(standardTerm);
  }

  const foreign =
    finding.proposedText === null || targetLanguage === null
      ? null
      : foreignLanguageOf(finding.proposedText, targetLanguage);
  if (foreign !== null && targetLanguage !== null) {
    reasons.push(
      `proposedText is written in ${languageDisplayName(foreign)}; the target document is written in ${languageDisplayName(targetLanguage)}. Rewrite it in ${languageDisplayName(targetLanguage)}, keeping the standard's meaning.`,
    );
  }

  return reasons;
};

/** What in a batch's answers the documents contradict, per position. */
export const findGradingViolations = (
  args: FindGradingViolationsArgs,
): GradingViolation[] => {
  const findingById = new Map<string, RepairableFinding>();
  for (const finding of args.findings) {
    if (!findingById.has(finding.positionId)) {
      findingById.set(finding.positionId, finding);
    }
  }

  const violations: GradingViolation[] = [];
  for (const position of args.positions) {
    const finding = findingById.get(position.sourceId);
    const reasons =
      finding === undefined
        ? ["no answer was given for this position."]
        : findingViolations(finding, position, args);
    if (reasons.length > 0) {
      violations.push({ positionId: position.sourceId, reasons });
    }
  }
  return violations;
};

/** The follow-up turn: the answers that failed, and why, in the model's own
 *  field names so the correction lands where the check reads. */
export const buildRepairMessage = (
  violations: readonly GradingViolation[],
): string => {
  const listed = violations
    .map(
      ({ positionId, reasons }) =>
        `- positionId=${positionId}\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
    )
    .join("\n");
  return `These answers do not check out against the documents. Answer the positions below again, once each, following the same rules; leave every other position out.\n${listed}`;
};

/** The batch after repair: a repaired answer replaces the one it corrects,
 *  and an answer the repair was not asked for is ignored. */
export const mergeRepairedFindings = <T extends { positionId: string }>({
  findings,
  repaired,
  violations,
}: {
  findings: readonly T[];
  repaired: readonly T[];
  violations: readonly GradingViolation[];
}): T[] => {
  const asked = new Set(violations.map(({ positionId }) => positionId));
  const merged = findings.filter(({ positionId }) => !asked.has(positionId));
  const seen = new Set<string>();
  for (const finding of repaired) {
    if (asked.has(finding.positionId) && !seen.has(finding.positionId)) {
      seen.add(finding.positionId);
      merged.push(finding);
    }
  }
  return merged;
};
