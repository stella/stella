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

import { panic, Result } from "better-result";
import * as v from "valibot";

import { mapWithConcurrency } from "@stll/concurrency";

import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  CLAIM_FACT_RELATIONS,
  SCORED_CLAIM_STATES,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimRef,
  ClaimVerdict,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import { createVerificationCall } from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";

/** Claims per grading call: the facts dominate the variable part of the
 *  prompt, so a batch amortises them without letting one failure take the
 *  whole run with it. */
const BATCH_SIZE = 10;
const CONCURRENCY = 3;

const GRADED_VERDICTS = [
  ...SCORED_CLAIM_STATES,
  "nocover",
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
});

const gradingSchema = v.strictObject({ grades: v.array(rawGradeSchema) });

type RawGrade = v.InferOutput<typeof rawGradeSchema>;

export type ClaimGrade = ClaimVerdict & { refs: ClaimRef[] };

export type GradeableClaim = { key: string; text: string };

const SYSTEM_PROMPT = `You check claims from a legal document against a record of evidence (the facts), one claim at a time.

For each claim choose a verdict:
- supported: the facts confirm it.
- tension: the facts partly fit but sit uneasily with it (a different date, amount or emphasis).
- contradicted: the facts refute it.
- nocover: no fact bears on it. This is a normal answer, not a failure; never stretch a fact to avoid it.
- recordconflict: two facts disagree with each other on the exact point the claim rests on, so the verdict depends on which record governs.

score is how strongly the facts support the claim, 0 to 100, for supported, tension and contradicted only; null otherwise. refs lists the facts the verdict rests on by factId, with rel supports, conflicts, or record (relevant context that neither supports nor conflicts). supported, tension and contradicted must cite at least one fact.

For recordconflict, fill conflict: subject (the disputed point, in a few words), factIds (exactly the two conflicting facts), values (what each of those facts says on the point, in the same order), and verdictIfGoverning (the verdict the claim would get if that fact governed, in the same order: supported, tension or contradicted). Otherwise conflict is null.

A fact's confidence says how unambiguous its meaning is and an interpretation note says where its meaning is contested; weigh them, but do not treat a low-confidence fact as absent. Use only the facts supplied. Answer every claim exactly once, preserving its claimId. The document is context for what a claim means, not evidence.`;

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

type Violation = { claimId: string; reason: string };

/** Hold one answer to the verdict rules, or say which one it breaks. */
const normalizeGrade = (
  raw: RawGrade,
  factIdByPromptId: ReadonlyMap<string, SafeId<"entity">>,
): Result<ClaimGrade, string> => {
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
    case "recordconflict": {
      const conflict = raw.conflict;
      const [first, second] = conflict?.factIds ?? [];
      const a = first === undefined ? undefined : factIdByPromptId.get(first);
      const b = second === undefined ? undefined : factIdByPromptId.get(second);
      const [valueA, valueB] = conflict?.values ?? [];
      const [ifA, ifB] = conflict?.verdictIfGoverning ?? [];
      if (
        conflict?.factIds.length !== 2 ||
        a === undefined ||
        b === undefined ||
        a === b ||
        valueA === undefined ||
        valueB === undefined ||
        ifA === undefined ||
        ifB === undefined
      ) {
        return Result.err(
          "is a record conflict without exactly two different supplied facts, their values and the verdict under each",
        );
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

const repairMessage = (violations: readonly Violation[]) =>
  `Some answers break the rules or are missing. Answer only these claims again:\n${violations
    .map(({ claimId, reason }) => `- ${claimId}: ${reason}`)
    .join("\n")}`;

type GradeClaimsArgs = {
  claims: readonly GradeableClaim[];
  facts: readonly VerificationEvidenceFact[];
  blocks: readonly VerificationBlock[];
  deps: VerificationModelDeps;
};

export type GradeClaimsOutcome =
  | { type: "graded"; grades: Map<string, ClaimGrade> }
  | { type: "incomplete"; ungraded: number };

/** A grade per claim key, or how many claims no answer could be held to. */
export const gradeClaims = async ({
  claims,
  facts,
  blocks,
  deps,
}: GradeClaimsArgs): Promise<
  Result<GradeClaimsOutcome, WorkflowIntegrationError>
> => {
  if (claims.length === 0) {
    return Result.ok({ type: "graded", grades: new Map() });
  }
  if (facts.length === 0) {
    // Nothing to check against is an answer, not a model call.
    return Result.ok({
      type: "graded",
      grades: new Map(
        claims.map((claim) => [
          claim.key,
          { state: "nocover", score: null, recordConflict: null, refs: [] },
        ]),
      ),
    });
  }

  const factIdByPromptId = new Map(
    facts.map((fact, index) => [`F${String(index + 1)}`, fact.factEntityId]),
  );
  const factsPart = `Facts:\n${facts
    .map((fact, index) => factLine(`F${String(index + 1)}`, fact))
    .join("\n")}`;
  const call = createVerificationCall({
    deps,
    feature: "lists.verification.grade",
    system: SYSTEM_PROMPT,
    blocks,
    outputSchema: gradingSchema,
  });
  const prompted = claims.map((claim, index) => ({
    promptId: `C${String(index + 1)}`,
    claim,
  }));
  const keyByPromptId = new Map(
    prompted.map(({ promptId, claim }) => [promptId, claim.key]),
  );
  const batches: (typeof prompted)[] = [];
  for (let start = 0; start < prompted.length; start += BATCH_SIZE) {
    batches.push(prompted.slice(start, start + BATCH_SIZE));
  }

  return await Result.tryPromise({
    try: async () => {
      const perBatch = await mapWithConcurrency({
        items: batches,
        limit: CONCURRENCY,
        operation: async (batch) => {
          const request = call.request(
            `${factsPart}\n\nClaims:\n${batch
              .map(({ promptId, claim }) => `- ${promptId}: ${claim.text}`)
              .join("\n")}`,
          );
          const graded = new Map<string, ClaimGrade>();
          const asked = new Set(batch.map(({ promptId }) => promptId));
          const hold = (answers: readonly RawGrade[]): Violation[] => {
            const violations: Violation[] = [];
            for (const raw of answers) {
              if (!asked.has(raw.claimId) || graded.has(raw.claimId)) {
                continue;
              }
              const grade = normalizeGrade(raw, factIdByPromptId);
              if (Result.isOk(grade)) {
                graded.set(raw.claimId, grade.value);
              } else {
                violations.push({ claimId: raw.claimId, reason: grade.error });
              }
            }
            return violations;
          };
          const output = await call.generate([request]);
          const violations = hold(output.grades);
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
              { role: "assistant", content: JSON.stringify(output) },
              { role: "user", content: repairMessage(violations) },
            ]);
            hold(repaired.grades);
          }
          return graded;
        },
      });

      const grades = new Map<string, ClaimGrade>();
      for (const graded of perBatch) {
        for (const [promptId, grade] of graded) {
          const key = keyByPromptId.get(promptId);
          if (key !== undefined) {
            grades.set(key, grade);
          }
        }
      }
      const ungraded = claims.length - grades.size;
      return ungraded === 0
        ? ({ type: "graded", grades } as const)
        : ({ type: "incomplete", ungraded } as const);
    },
    catch: (cause) => {
      call.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Claim grading failed",
        cause,
      });
    },
  });
};
