import { panic, Result } from "better-result";
/**
 * Pass two: check each factual claim against the pinned facts.
 *
 * Facts and claims are shown under short sequential ids (`F1`, `C1`) the
 * model copies reliably; they map back to entity ids here. The model picks a
 * verdict and cites facts; this module holds the answer to the verdict rules
 * the schema enforces (a scored verdict rests on a cited fact, a record
 * conflict names two different facts) and shows violations back once. A
 * claim still unanswered after that fails the run: an ungraded claim shown as
 * "no coverage" would read as a finding nobody made.
 */
import * as v from "valibot";

import { mapWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { parsePartialDate } from "@/api/lib/lists/fact-details";
import type { PartialDate } from "@/api/lib/lists/fact-details";
import { claimPassage } from "@/api/lib/lists/verification/claim-context";
import { claimAssertedDate } from "@/api/lib/lists/verification/claim-date";
import {
  CLAIM_FACT_RELATIONS,
  SCORED_CLAIM_STATES,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimAnchor,
  ClaimAssertedDate,
  ClaimGrade,
  ClaimRef,
  ClaimVerdict,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import { createVerificationCall } from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import {
  CLAIM_QUALIFIER_EXPLANATION_MAX,
  GRADER_CLAIM_QUALIFIERS,
  graderQualifierFits,
} from "@/api/lib/lists/verification/qualifiers";
import type { GraderClaimQualifier } from "@/api/lib/lists/verification/qualifiers";

/** Claims per grading call: the facts dominate the variable part of the
 *  prompt, so a batch amortises them without letting one failure take the
 *  whole run with it. */
export const GRADING_BATCH_SIZE = 10;
export const GRADING_CONCURRENCY = 3;

const GRADED_VERDICTS = [
  ...SCORED_CLAIM_STATES,
  "nocover",
  "notverifiable",
  "recordconflict",
] as const;

// Flat rather than a union: providers honour a flat JSON Schema most reliably.
const rawGradeSchema = v.strictObject({
  claimId: v.string(),
  verdict: v.picklist(GRADED_VERDICTS),
  /** 0-100 support for supported, tension and contradicted; else null. */
  score: v.nullable(v.number()),
  refs: v.array(
    v.strictObject({
      factId: v.string(),
      rel: v.picklist(CLAIM_FACT_RELATIONS),
    }),
  ),
  conflict: v.nullable(
    v.strictObject({
      subject: v.string(),
      factIds: v.array(v.string()),
      values: v.array(v.string()),
      verdictIfGoverning: v.array(v.picklist(SCORED_CLAIM_STATES)),
    }),
  ),
  qualifiers: v.array(
    v.strictObject({
      kind: v.picklist(GRADER_CLAIM_QUALIFIERS),
      explanation: v.string(),
    }),
  ),
  /** The date the claim's words give, `YYYY[-MM[-DD]]`; read only when the
   *  words alone name no complete date (`claim-date.ts`). */
  statedDate: v.nullable(v.string()),
});

/** Read by the structured-output role contract test. @public */
export const gradingSchema = v.strictObject({
  grades: v.array(rawGradeSchema),
});

type RawGrade = v.InferOutput<typeof rawGradeSchema>;

type GradedVerdict = ClaimVerdict & { refs: ClaimRef[] };

/** A claim to grade, with the text of the block it sits in for meaning and
 *  the facts a reviewer pointed it at, if any. */
type GradeableClaim = {
  key: string;
  text: string;
  context: { text: string; anchor: Pick<ClaimAnchor, "start" | "end"> };
  linkedFactIds: readonly SafeId<"entity">[];
};

const SYSTEM_PROMPT = `You check claims from a legal document against a record of evidence (the facts), one claim at a time.

For each claim choose a verdict:
- supported: the facts confirm the claim as worded, including its approximate or qualified terms.
- tension: relevant facts partly fit or challenge the claim without conclusively refuting it (for example, an ambiguous source, date or interpretation).
- contradicted: the facts directly establish the opposite of the claim as worded, taking its qualifications into account.
- nocover: the claim is checkable, but no fact directly bears on it. Shared people or subject matter alone is not coverage; a claim framed "to my knowledge" can still be checkable.
- notverifiable: the claim itself is an opinion, hypothetical expectation or private judgment that evidence cannot test. Lack of evidence for a checkable claim is nocover instead.
- recordconflict: two facts give incompatible accounts of the same material point in a transaction or disclosure, so the claim's verdict changes with the governing record. If both accounts support the claim as worded, use supported or tension instead.

score is how strongly the facts support the claim, 0 to 100, for supported, tension and contradicted only; null otherwise. refs lists the facts the verdict rests on by factId, with rel supports, conflicts, or record (relevant context that neither supports nor conflicts). supported, tension and contradicted must cite at least one fact.

qualifiers lists caveats on the verdict, usually none; each has a kind and a one-sentence explanation of what the record does and does not say:
- record-silent: only with nocover, when the record is not expected to speak to the point at all (background, framing, the author's own state of mind), so the missing coverage is not a gap in the evidence.
- scope-mismatch: the fact the verdict turns on is about a different period, population, place, measure or unit than the claim.
A difference in scope alone never makes a claim contradicted: when the only conflicting fact differs in scope, grade on what the record says about the claim's own scope (usually nocover or tension) and add scope-mismatch.

For recordconflict, fill conflict: subject (the disputed point, in a few words), factIds (exactly the two conflicting facts), values (what each of those facts says on the point, in the same order), and verdictIfGoverning (the verdict the claim would get if that fact governed, in the same order: supported, tension or contradicted). Otherwise conflict is null.

statedDate is the date the claim's own words give for what it asserts, as YYYY-MM-DD, YYYY-MM or YYYY, stating only as much as the claim does; when the claim gives a day or month without its year, take the year from its passage. null when the claim gives no date or only a relative one ("the next day", "a week later"). Never take it from the facts.

A fact's confidence says how unambiguous its meaning is and an interpretation note says where its meaning is contested; weigh them, but do not treat a low-confidence fact as absent. A claim may name facts a reviewer points to as bearing on it: read those first, but grade on what they say; being pointed to is not support. Use only the facts supplied. Answer every claim exactly once, preserving its claimId. Each claim comes with the passage it sits in: that passage says what the claim means and is never evidence.`;

const factLine = (id: string, fact: VerificationEvidenceFact): string => {
  const detail = [
    fact.occurredOn === null
      ? null
      : `date=${fact.occurredOn} (${fact.occurredOnPrecision ?? "day"})`,
    fact.evidenceKind === null ? null : `kind=${fact.evidenceKind}`,
    fact.medium === null ? null : `medium=${fact.medium}`,
    fact.confidence === null ? null : `confidence=${fact.confidence}`,
    fact.interpretationNote === null
      ? null
      : `interpretation note=${fact.interpretationNote}`,
  ].filter((part) => part !== null);
  return `- ${id}: ${fact.text}${detail.length === 0 ? "" : `\n  ${detail.join("; ")}`}`;
};

/** The facts a reviewer pointed the claim at, by prompt id. A pointed fact
 *  the grading does not carry (held since) is left out. */
const pointedLine = (
  claim: GradeableClaim,
  promptIdByFactId: ReadonlyMap<SafeId<"entity">, string>,
): string => {
  // A linked fact the check does not read has no prompt id to point at.
  const pointed = claim.linkedFactIds.flatMap((factId) => {
    const promptId = promptIdByFactId.get(factId);
    return promptId === undefined ? [] : [promptId];
  });
  return pointed.length === 0
    ? ""
    : `\n  reviewer points to: ${pointed.join(", ")}`;
};

type Violation = { claimId: string; reason: string };

/** Hold one answer's verdict to the verdict rules, or say which it breaks. */
const normalizeVerdict = (
  raw: RawGrade,
  factIdByPromptId: ReadonlyMap<string, SafeId<"entity">>,
): Result<GradedVerdict, string> => {
  const refs: ClaimRef[] = [];
  const seen = new Set<string>();
  for (const ref of raw.refs) {
    const factEntityId = factIdByPromptId.get(ref.factId);
    if (factEntityId === undefined || seen.has(ref.factId)) {
      continue;
    }
    seen.add(ref.factId);
    refs.push({ factEntityId, rel: ref.rel });
  }

  switch (raw.verdict) {
    case "supported":
    case "tension":
    case "contradicted": {
      if (raw.score === null) {
        return Result.err("gives no score for a scored verdict");
      }
      if (refs.length === 0) {
        return Result.err("cites no supplied fact for its verdict");
      }
      return Result.ok({
        state: raw.verdict,
        score: Math.round(Math.min(100, Math.max(0, raw.score))),
        recordConflict: null,
        refs,
      });
    }
    case "nocover": {
      return Result.ok({
        state: raw.verdict,
        score: null,
        recordConflict: null,
        refs: refs.filter((ref) => ref.rel === "record"),
      });
    }
    case "notverifiable": {
      return Result.ok({
        state: raw.verdict,
        score: null,
        recordConflict: null,
        refs: [],
      });
    }
    case "recordconflict": {
      const conflict = raw.conflict;
      const invalidConflict =
        "is a record conflict without exactly two different supplied facts, their values and the verdict under each";
      if (conflict === null) {
        return Result.err(invalidConflict);
      }
      const [first, second] = conflict.factIds;
      const a = first === undefined ? undefined : factIdByPromptId.get(first);
      const b = second === undefined ? undefined : factIdByPromptId.get(second);
      const [valueA, valueB] = conflict.values;
      const [ifA, ifB] = conflict.verdictIfGoverning;
      if (
        conflict.factIds.length !== 2 ||
        a === undefined ||
        b === undefined ||
        a === b ||
        valueA === undefined ||
        valueB === undefined ||
        ifA === undefined ||
        ifB === undefined
      ) {
        return Result.err(invalidConflict);
      }
      return Result.ok({
        state: raw.verdict,
        score: null,
        recordConflict: {
          subject: conflict.subject,
          factEntityIds: [a, b],
          values: [valueA, valueB],
          governingStates: [ifA, ifB],
        },
        refs,
      });
    }
    default: {
      raw.verdict satisfies never;
      return panic(`Unhandled verdict: ${String(raw.verdict)}`);
    }
  }
};

/** Hold one answer's qualifiers to the pairing rules, or say which it
 *  breaks. */
const normalizeQualifiers = (
  raw: RawGrade["qualifiers"],
  state: ClaimVerdict["state"],
): Result<GraderClaimQualifier[], string> => {
  const qualifiers: GraderClaimQualifier[] = [];
  for (const { kind, explanation } of raw) {
    if (!graderQualifierFits(kind, state)) {
      return Result.err(`gives ${kind} with a ${state} verdict`);
    }
    if (qualifiers.some((qualifier) => qualifier.kind === kind)) {
      return Result.err(`gives ${kind} more than once`);
    }
    const trimmed = explanation.trim();
    if (trimmed === "") {
      return Result.err(`gives ${kind} without an explanation`);
    }
    qualifiers.push({
      kind,
      explanation: trimmed.slice(0, CLAIM_QUALIFIER_EXPLANATION_MAX),
    });
  }
  return Result.ok(qualifiers);
};

/** Hold one answer to the verdict and qualifier rules, or say which one it
 *  breaks. */
const normalizeGrade = (
  raw: RawGrade,
  factIdByPromptId: ReadonlyMap<string, SafeId<"entity">>,
): Result<ClaimGrade, string> => {
  const verdict = normalizeVerdict(raw, factIdByPromptId);
  if (Result.isError(verdict)) {
    return verdict;
  }
  const qualifiers = normalizeQualifiers(raw.qualifiers, verdict.value.state);
  if (Result.isError(qualifiers)) {
    return qualifiers;
  }
  return Result.ok({ ...verdict.value, qualifiers: qualifiers.value });
};

const repairMessage = (violations: readonly Violation[]) =>
  `Some answers break the rules or are missing. Answer only these claims again:\n${violations
    .map(({ claimId, reason }) => `- ${claimId}: ${reason}`)
    .join("\n")}`;

type GradeClaimsArgs = {
  claims: readonly GradeableClaim[];
  facts: readonly VerificationEvidenceFact[];
  deps: VerificationModelDeps;
};

/** `incomplete` keeps the grades it has: a run fails on any claim left
 *  unanswered, a re-check records the claims that were answered. */
export type GradeClaimsOutcome =
  | {
      type: "graded";
      grades: Map<string, ClaimGrade>;
      /** Each claim's asserted date: its words', else the grader's. */
      assertedDates: Map<string, ClaimAssertedDate>;
    }
  | {
      type: "incomplete";
      grades: Map<string, ClaimGrade>;
      /** The asserted date of each graded claim. */
      assertedDates: Map<string, ClaimAssertedDate>;
      ungraded: number;
    };

/** The asserted date of each claim, with the grader's answer where it gave
 *  one. */
const assertedDatesOf = (
  claims: readonly GradeableClaim[],
  statedDates: ReadonlyMap<string, PartialDate | null>,
): Map<string, ClaimAssertedDate> =>
  new Map(
    claims.map((claim) => [
      claim.key,
      claimAssertedDate(claim.text, statedDates.get(claim.key) ?? null),
    ]),
  );

/** A grade per claim key, or how many claims no answer could be held to. */
export const gradeClaims = async ({
  claims,
  facts,
  deps,
}: GradeClaimsArgs): Promise<
  Result<GradeClaimsOutcome, WorkflowIntegrationError>
> => {
  if (claims.length === 0) {
    return Result.ok({
      type: "graded",
      grades: new Map(),
      assertedDates: new Map(),
    });
  }
  if (facts.length === 0) {
    // Nothing to check against is an answer, not a model call.
    return Result.ok({
      type: "graded",
      grades: new Map(
        claims.map((claim) => [
          claim.key,
          {
            state: "nocover",
            score: null,
            recordConflict: null,
            refs: [],
            qualifiers: [],
          },
        ]),
      ),
      assertedDates: assertedDatesOf(claims, new Map()),
    });
  }

  const factIdByPromptId = new Map(
    facts.map((fact, index) => [`F${String(index + 1)}`, fact.factEntityId]),
  );
  const promptIdByFactId = new Map(
    [...factIdByPromptId].map(([promptId, factId]) => [factId, promptId]),
  );
  const factsPart = `Facts:\n${facts
    .map((fact, index) => factLine(`F${String(index + 1)}`, fact))
    .join("\n")}`;
  const call = createVerificationCall({
    deps,
    feature: "lists.verification.grade",
    system: SYSTEM_PROMPT,
    // Every batch is graded against the same facts, so they are the part
    // the prompt cache keeps.
    shared: factsPart,
    outputSchema: gradingSchema,
  });
  const prompted = claims.map((claim, index) => ({
    promptId: `C${String(index + 1)}`,
    claim,
  }));
  const keyByPromptId = new Map(
    prompted.map(({ promptId, claim }) => [promptId, claim.key]),
  );
  const batches = chunkItems(prompted, GRADING_BATCH_SIZE);

  return Result.flatten(
    await Result.tryPromise({
      try: async () => {
        const perBatch = await mapWithConcurrency({
          items: batches,
          limit: GRADING_CONCURRENCY,
          operation: async (batch) => {
            const request = call.request(
              `Claims:\n${batch
                .map(
                  ({ promptId, claim }) =>
                    `- ${promptId}: ${claim.text}\n  passage: ${claimPassage(claim.context.text, claim.context.anchor)}${pointedLine(claim, promptIdByFactId)}`,
                )
                .join("\n")}`,
            );
            const graded = new Map<
              string,
              { grade: ClaimGrade; statedDate: PartialDate | null }
            >();
            const asked = new Set(batch.map(({ promptId }) => promptId));
            const hold = (answers: readonly RawGrade[]): Violation[] => {
              const violations: Violation[] = [];
              for (const raw of answers) {
                if (!asked.has(raw.claimId) || graded.has(raw.claimId)) {
                  continue;
                }
                const grade = normalizeGrade(raw, factIdByPromptId);
                if (Result.isOk(grade)) {
                  graded.set(raw.claimId, {
                    grade: grade.value,
                    statedDate: parsePartialDate(raw.statedDate),
                  });
                } else {
                  violations.push({
                    claimId: raw.claimId,
                    reason: grade.error,
                  });
                }
              }
              return violations;
            };
            const output = await call.generate([request]);
            if (Result.isError(output)) {
              return output;
            }
            const violations = hold(output.value.grades);
            for (const { promptId } of batch) {
              if (
                !graded.has(promptId) &&
                !violations.some((violation) => violation.claimId === promptId)
              ) {
                violations.push({
                  claimId: promptId,
                  reason: "was not answered",
                });
              }
            }
            if (violations.length > 0) {
              const repaired = await call.generate([
                request,
                { role: "assistant", content: JSON.stringify(output.value) },
                { role: "user", content: repairMessage(violations) },
              ]);
              if (Result.isError(repaired)) {
                return repaired;
              }
              hold(repaired.value.grades);
            }
            return Result.ok(graded);
          },
        });

        const grades = new Map<string, ClaimGrade>();
        const statedDates = new Map<string, PartialDate | null>();
        for (const batch of perBatch) {
          if (batch.isErr()) {
            return Result.err(
              new WorkflowIntegrationError({
                message: "Claim grading failed",
                cause: batch.error,
              }),
            );
          }
          for (const [promptId, { grade, statedDate }] of batch.value) {
            const key = keyByPromptId.get(promptId);
            if (key !== undefined) {
              grades.set(key, grade);
              statedDates.set(key, statedDate);
            }
          }
        }
        const ungraded = claims.length - grades.size;
        return Result.ok(
          ungraded === 0
            ? ({
                type: "graded",
                grades,
                assertedDates: assertedDatesOf(claims, statedDates),
              } as const)
            : ({
                type: "incomplete",
                grades,
                assertedDates: assertedDatesOf(
                  claims.filter((claim) => grades.has(claim.key)),
                  statedDates,
                ),
                ungraded,
              } as const),
        );
      },
      catch: (cause) => {
        call.captureError(cause);
        return new WorkflowIntegrationError({
          message: "Claim grading failed",
          cause,
        });
      },
    }),
  );
};
