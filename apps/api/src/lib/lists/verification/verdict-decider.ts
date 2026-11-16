/**
 * Who decides a claim's verdict: the language model that grades it, or,
 * when the organization turned it on, the decision model (TypeSafe System
 * One, the Jev family).
 *
 * The language model always does what only it can: read the claim in its
 * passage, find the facts that bear on it, cite them with their stance, and
 * give the qualifiers. The decision model then reads the claim and the facts
 * the grader cited, and picks the verdict category. Its verdict replaces the
 * grader's only when it clears the model's calibrated confidence floor and
 * fits what the grader cited; otherwise the grader's verdict stands and the
 * grade records why. Every grade records who decided it.
 *
 * One owner for run grading, a re-check and a bulk re-check alike: all of
 * them grade through `gradeClaims`, which asks this module per batch.
 */

import { panic, Result } from "better-result";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CLAIM_STATE,
  SCORED_CLAIM_STATES,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimGrade,
  ClaimState,
  DecidedClaimGrade,
  VerdictFallbackReason,
  VerdictProvenance,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import { admitVerificationDispatch } from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { graderQualifierFits } from "@/api/lib/lists/verification/qualifiers";
import { admittedDispatchSignal } from "@/api/lib/rate-limit/model-dispatch-admission";
import { decideWithoutRecovery } from "@/api/lib/workflow/decisions/decide";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import { resolveDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { choice } from "@/api/lib/workflow/decisions/system-one";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  SystemOneEntry,
} from "@/api/lib/workflow/decisions/system-one";

/** What the decision model may answer for a claim. */
export const VERDICT_OUTCOMES = [
  "confirmed",
  "strained",
  "refuted",
  "uncovered",
  "untestable",
  "records-disagree",
] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

/** Each outcome is exactly one claim state, and every state has one. */
export const VERDICT_STATE_BY_OUTCOME = {
  confirmed: CLAIM_STATE.SUPPORTED,
  strained: CLAIM_STATE.TENSION,
  refuted: CLAIM_STATE.CONTRADICTED,
  uncovered: CLAIM_STATE.NOCOVER,
  untestable: CLAIM_STATE.NOTVERIFIABLE,
  "records-disagree": CLAIM_STATE.RECORDCONFLICT,
} as const satisfies Record<VerdictOutcome, ClaimState>;

/** The grader's own verdict rules, as the decision model's criteria. */
const VERDICT_CRITERIA = {
  confirmed:
    "The cited facts confirm the claim as worded, including its approximate or qualified terms.",
  strained:
    "Relevant cited facts partly fit or challenge the claim without conclusively refuting it (an ambiguous source, date or interpretation).",
  refuted:
    "The cited facts directly establish the opposite of the claim as worded, taking its qualifications into account.",
  uncovered:
    "The claim is checkable, but no cited fact directly bears on it. Shared people or subject matter alone is not coverage, and a fact about a different period, place, population or measure does not cover it.",
  untestable:
    "The claim itself is an opinion, hypothetical expectation or private judgment that evidence cannot test. Lack of evidence for a checkable claim is uncovered instead.",
  "records-disagree":
    "Two cited facts give incompatible accounts of the same material point, so the verdict changes with which record governs.",
} as const satisfies Record<VerdictOutcome, string>;

const verdictQuestion = (promptId: string): ChoiceQuestion<VerdictOutcome> =>
  choice(
    {
      task: `Which verdict do the facts cited for claim ${promptId} in \`claims\` give it?`,
      read: "`passage` is the text around the claim: it says what the claim means and is never evidence. `stance` is how a first reader cited each fact; judge the fact's own words, not the stance. A fact's `confidence` and `interpretation_note` say how unambiguous it is; weigh them, but do not treat a low-confidence fact as absent.",
    },
    VERDICT_CRITERIA,
  );

/** How the decision model reads one cited fact. */
const FACT_STANCES = {
  supports: "supports",
  conflicts: "conflicts",
  record: "context",
} as const satisfies Record<ClaimGrade["refs"][number]["rel"], string>;

/** The runtime choice: whether the decision model is asked, and which. */
export type VerdictDecider =
  { kind: "llm" } | { kind: "decision-model"; model: DecisionModel | null };

export const LLM_DECIDER = { kind: "llm" } as const satisfies VerdictDecider;

type ResolveVerdictDeciderOptions = {
  /** The organization's switch. */
  enabled: boolean;
  orgAIConfig: OrgAIConfig | null;
  /** Injected by tests; the organization's resolved decision model otherwise. */
  resolveModel?: typeof resolveDecisionModel | undefined;
};

/**
 * Off, the decision model is never resolved or asked. On, the grade records
 * the model that answered, or why none did (an organization that turned the
 * switch on and then removed its decision model gets `no-backend`).
 */
export const resolveVerdictDecider = ({
  enabled,
  orgAIConfig,
  resolveModel = resolveDecisionModel,
}: ResolveVerdictDeciderOptions): VerdictDecider =>
  enabled
    ? {
        kind: "decision-model",
        model: resolveModel(orgAIConfig, "customer"),
      }
    : LLM_DECIDER;

/** A claim the grader graded, as the decision model reads it. */
type VerdictCandidate = {
  promptId: string;
  claim: string;
  passage: string;
  grade: ClaimGrade;
};

type CitedFact = { promptId: string; fact: VerificationEvidenceFact };

/** The facts a grade cites, each once: its refs, then a record conflict's
 *  two records when the refs leave one out. */
const citedFacts = (
  grade: ClaimGrade,
  facts: ReadonlyMap<SafeId<"entity">, CitedFact>,
): Record<string, SystemOneEntry>[] => {
  const stances = new Map<SafeId<"entity">, string>(
    grade.refs.map((ref) => [ref.factEntityId, FACT_STANCES[ref.rel]]),
  );
  if (grade.recordConflict !== null) {
    for (const factEntityId of grade.recordConflict.factEntityIds) {
      if (!stances.has(factEntityId)) {
        stances.set(factEntityId, "disputed record");
      }
    }
  }
  return [...stances].flatMap(([factEntityId, stance]) => {
    const cited = facts.get(factEntityId);
    if (cited === undefined) {
      return [];
    }
    const { fact } = cited;
    return [
      {
        id: cited.promptId,
        text: fact.text,
        stance,
        date: fact.occurredOn,
        // A month or year date is stored as its first day; say so, as the
        // grader's fact lines do, so it does not read as an exact day.
        date_precision:
          fact.occurredOn === null ? null : (fact.occurredOnPrecision ?? "day"),
        confidence: fact.confidence,
        interpretation_note: fact.interpretationNote,
      },
    ];
  });
};

/** 0-100 support from the decision model's distribution over the scored
 *  outcomes: confirmed counts whole, strained half, refuted none. */
const supportScore = (
  probabilities: Record<VerdictOutcome, number>,
): number | null => {
  const { confirmed, strained, refuted } = probabilities;
  const scored = confirmed + strained + refuted;
  return scored <= 0
    ? null
    : Math.round((100 * (confirmed + strained / 2)) / scored);
};

const isScoredState = (
  state: ClaimState,
): state is (typeof SCORED_CLAIM_STATES)[number] =>
  SCORED_CLAIM_STATES.some((scored) => scored === state);

/**
 * The grader's grade under the decision model's verdict, held to the same
 * verdict rules the grader is: a scored verdict cites a fact and carries a
 * score, missing coverage cites only context, a record conflict names its
 * two records. Null when the grade cannot carry that verdict (a record
 * conflict the grader never named, a scored verdict with nothing cited).
 */
const applyDecidedVerdict = (
  grade: ClaimGrade,
  answer: ChoiceAnswer<VerdictOutcome>,
): ClaimGrade | null => {
  const state = VERDICT_STATE_BY_OUTCOME[answer.choice];
  if (state === grade.state) {
    return grade;
  }
  const qualifiers = grade.qualifiers.filter(({ kind }) =>
    graderQualifierFits(kind, state),
  );
  if (isScoredState(state)) {
    const score = supportScore(answer.probabilities);
    if (grade.refs.length === 0 || score === null) {
      return null;
    }
    return {
      state,
      score,
      recordConflict: null,
      refs: grade.refs,
      qualifiers,
    };
  }
  switch (state) {
    case "nocover": {
      return {
        state,
        score: null,
        recordConflict: null,
        refs: grade.refs.filter((ref) => ref.rel === "record"),
        qualifiers,
      };
    }
    case "notverifiable": {
      return {
        state,
        score: null,
        recordConflict: null,
        refs: [],
        qualifiers,
      };
    }
    case "recordconflict": {
      // Only the grader names the two records; it named none here.
      return null;
    }
    default: {
      state satisfies never;
      return panic(`Unhandled claim state: ${String(state)}`);
    }
  }
};

const fellBack = (
  grade: ClaimGrade,
  reason: VerdictFallbackReason,
  model: string | null,
  confidence: number | null,
): DecidedClaimGrade => ({
  ...grade,
  decider: { kind: "llm", fallback: { reason, model, confidence } },
});

/** One claim's grade under one decision. */
const settleVerdict = (
  grade: ClaimGrade,
  decision: Decision<ChoiceAnswer<VerdictOutcome>>,
): DecidedClaimGrade => {
  if (decision.state === "undecided") {
    return fellBack(
      grade,
      decision.reason,
      decision.model,
      decision.confidence,
    );
  }
  const decided = applyDecidedVerdict(grade, decision.answer);
  if (decided === null || decision.model === null) {
    return fellBack(grade, "incompatible", decision.model, decision.confidence);
  }
  const decider: VerdictProvenance = {
    kind: "decision-model",
    model: decision.model,
    confidence: decision.confidence,
    replaced: grade.state,
  };
  return { ...decided, decider };
};

type DecideVerdictsArgs = {
  decider: VerdictDecider;
  candidates: readonly VerdictCandidate[];
  /** Every fact the grader read, by entity id, under its prompt id. */
  facts: ReadonlyMap<SafeId<"entity">, CitedFact>;
  deps: VerificationModelDeps;
};

/**
 * The verdict of each graded claim, by prompt id, with who decided it. One
 * decision call per batch of claims. A call that fails, is refused, or is
 * not admitted leaves every grader verdict standing with the reason.
 */
export const decideVerdicts = async ({
  decider,
  candidates,
  facts,
  deps,
}: DecideVerdictsArgs): Promise<Map<string, DecidedClaimGrade>> => {
  const settled = new Map<string, DecidedClaimGrade>();
  if (decider.kind === "llm") {
    for (const { promptId, grade } of candidates) {
      settled.set(promptId, {
        ...grade,
        decider: { kind: "llm", fallback: null },
      });
    }
    return settled;
  }
  const fallBackAll = (reason: VerdictFallbackReason) => {
    for (const { promptId, grade } of candidates) {
      settled.set(promptId, fellBack(grade, reason, null, null));
    }
    return settled;
  };
  if (candidates.length === 0) {
    return settled;
  }
  if (decider.model === null) {
    return fallBackAll("no-backend");
  }
  const admitted = await admitVerificationDispatch(deps);
  if (Result.isError(admitted)) {
    return fallBackAll("not-admitted");
  }
  const { decisions } = await decideWithoutRecovery({
    id: "lists.verification.verdict",
    orgAIConfig: deps.orgAIConfig,
    dataClass: "customer",
    state: {
      claims: Object.fromEntries(
        candidates.map(({ promptId, claim, passage, grade }) => [
          promptId,
          { claim, passage, facts: citedFacts(grade, facts) },
        ]),
      ),
    },
    questions: Object.fromEntries(
      candidates.map(({ promptId }) => [promptId, verdictQuestion(promptId)]),
    ),
    confidencePurpose: "verdict",
    // The admission's signal too: a run that loses its lease stops here.
    abortSignal: admittedDispatchSignal({
      userId: deps.admission.userId,
      organizationId: deps.organizationId,
      admission: deps.admission,
      abortSignal: deps.abortSignal,
    }),
    client: decider.model,
    usageMetering: { ...deps.usageMetering, callId: Bun.randomUUIDv7() },
  });
  for (const { promptId, grade } of candidates) {
    const decision =
      decisions[promptId] ??
      panic(`The verdict decision lost claim "${promptId}"`);
    settled.set(promptId, settleVerdict(grade, decision));
  }
  return settled;
};
