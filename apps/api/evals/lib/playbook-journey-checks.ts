/**
 * What the playbook journey asserts about a finished review run, as pure
 * functions over the API's responses so they can be tested without a model.
 * Each returns the problems it found; an empty list is a pass.
 */
import * as v from "valibot";

import { UNGRADED_RATIONALE } from "@/api/lib/document-review/review-grade";
import { CUT_DOCUMENT_RATIONALE } from "@/api/lib/workflow/verdict-engine";
import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

// --------------- Response shapes (only what the journey reads) ---------------

const findingSchema = v.object({
  id: v.string(),
  positionId: v.string(),
  positionTitle: v.string(),
  outcome: v.nullable(v.string()),
  suggestionId: v.nullable(v.string()),
  payload: v.object({
    finding: v.object({
      verdict: v.nullable(v.string()),
      standardSource: v.string(),
      rationale: v.nullable(v.string()),
      explanation: v.optional(v.object({ type: v.string() })),
      fix: v.nullable(v.unknown()),
    }),
  }),
});

export const runDetailSchema = v.object({
  run: v.object({
    id: v.string(),
    status: v.string(),
    executor: v.string(),
    errorCode: v.nullable(v.string()),
    total: v.number(),
    completed: v.number(),
  }),
  findings: v.array(findingSchema),
});

export type RunDetail = v.InferOutput<typeof runDetailSchema>;
export type RunFinding = RunDetail["findings"][number];

/** One poll of a run while it was being watched. */
export type RunPoll = {
  status: string;
  total: number;
  completed: number;
  findings: number;
};

export const pollOf = ({ run, findings }: RunDetail): RunPoll => ({
  status: run.status,
  total: run.total,
  completed: run.completed,
  findings: findings.length,
});

const nonEmpty = v.pipe(v.string(), v.minLength(1));

/** An executable redline, in the shape `GroundedReviewFix` gives it. */
const fixSchema = v.variant("kind", [
  v.object({
    kind: v.literal("replaceInBlock"),
    blockId: nonEmpty,
    find: nonEmpty,
    replace: v.string(),
  }),
  v.object({
    kind: v.literal("replaceBlock"),
    blockId: nonEmpty,
    text: nonEmpty,
  }),
  v.object({
    kind: v.literal("insertAfterBlock"),
    blockId: nonEmpty,
    text: nonEmpty,
  }),
]);

const isVerdictTier = (value: string | null): value is VerdictTier =>
  value !== null && (VERDICT_TIERS as readonly string[]).includes(value);

// --------------- Checks ---------------

/**
 * The run ended `completed`, with no error, and its progress accounts for
 * every finding: `completed` and `total` both equal the findings it holds and
 * the positions it was given. While it ran, progress never sat at 0 with
 * findings already recorded: one such poll can be the gap between writing a
 * batch and recounting it, two are a stalled count.
 */
export const checkRunProgress = ({
  detail,
  polls,
  expectedFindings,
}: {
  detail: RunDetail;
  polls: readonly RunPoll[];
  expectedFindings: number;
}): string[] => {
  const problems: string[] = [];
  const { run, findings } = detail;
  if (run.status !== "completed") {
    problems.push(
      `ended ${run.status}${run.errorCode === null ? "" : ` (${run.errorCode})`}, not completed`,
    );
  } else if (run.errorCode !== null) {
    problems.push(`completed with error code ${run.errorCode}`);
  }
  if (findings.length !== expectedFindings) {
    problems.push(
      `${String(findings.length)} findings for ${String(expectedFindings)} positions`,
    );
  }
  if (run.total !== findings.length || run.completed !== findings.length) {
    problems.push(
      `progress reads ${String(run.completed)} of ${String(run.total)} with ${String(findings.length)} findings`,
    );
  }
  const stalled = polls.filter(
    (poll) =>
      poll.status === "running" && poll.findings > 0 && poll.completed === 0,
  ).length;
  if (stalled >= 2) {
    problems.push(
      `progress stayed at 0 with findings recorded across ${String(stalled)} polls`,
    );
  }
  return problems;
};

/** Tiers a finding may take: the fixture's for an authored position, the
 *  reference set for a position proposed from a precedent. */
export type ExpectedTiers = {
  byPositionId: Readonly<Record<string, readonly VerdictTier[]>>;
  reference: readonly VerdictTier[];
  fixPositionIds: ReadonlySet<string>;
};

/**
 * Every finding has a known verdict in the expected set, none is `missing`
 * (the fixtures state every term they are graded on, so `missing` can only
 * mean an answer was lost), none records a comparison that never ran or a
 * document read only in part, and, from the panel, a deviation the position
 * carries ideal language for comes with a proposed fix.
 */
export const checkFindings = ({
  findings,
  expected,
  expectFixes,
}: {
  findings: readonly RunFinding[];
  expected: ExpectedTiers;
  expectFixes: boolean;
}): string[] => {
  const problems: string[] = [];
  for (const finding of findings) {
    const label = finding.positionTitle;
    const { verdict, rationale, standardSource, explanation, fix } =
      finding.payload.finding;
    if (!isVerdictTier(verdict)) {
      problems.push(`${label}: unknown verdict ${String(verdict)}`);
      continue;
    }
    if (verdict === "missing") {
      problems.push(`${label}: graded missing, but the contract states it`);
      continue;
    }
    if (rationale === UNGRADED_RATIONALE) {
      problems.push(`${label}: the comparison never completed`);
      continue;
    }
    if (rationale === CUT_DOCUMENT_RATIONALE) {
      problems.push(`${label}: the document was not read in full`);
      continue;
    }
    const allowed =
      standardSource === "reference"
        ? expected.reference
        : expected.byPositionId[finding.positionId];
    if (allowed === undefined) {
      problems.push(`${label}: not a position of the fixture playbook`);
      continue;
    }
    if (!allowed.includes(verdict)) {
      problems.push(
        `${label}: graded ${verdict}, expected ${allowed.join(" or ")}`,
      );
      continue;
    }
    if (
      standardSource === "reference" &&
      verdict === "not-applicable" &&
      explanation?.type !== "comparison"
    ) {
      problems.push(`${label}: not compared with the reference`);
      continue;
    }
    if (
      expectFixes &&
      verdict === "deviation" &&
      expected.fixPositionIds.has(finding.positionId) &&
      !v.is(fixSchema, fix) &&
      finding.suggestionId === null
    ) {
      problems.push(`${label}: deviation without a proposed fix`);
    }
  }
  return problems;
};

/**
 * The table's verdict cells, which the badge renders, hold known tiers and
 * agree with the findings the table run recorded for the same document.
 */
export const checkBadges = ({
  cellValues,
  findings,
}: {
  cellValues: readonly (string | null)[];
  findings: readonly RunFinding[];
}): string[] => {
  const problems: string[] = [];
  for (const value of cellValues) {
    if (!isVerdictTier(value)) {
      problems.push(`verdict cell holds ${String(value)}, not a known tier`);
    }
  }
  const sorted = (values: readonly (string | null)[]) =>
    values.map(String).toSorted();
  const cells = sorted(cellValues);
  const outcomes = sorted(findings.map((finding) => finding.outcome));
  if (cells.join(",") !== outcomes.join(",")) {
    problems.push(
      `verdict cells [${cells.join(", ")}] differ from findings [${outcomes.join(", ")}]`,
    );
  }
  return problems;
};
