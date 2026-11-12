/**
 * Who decides a claim's verdict. The decision model's verdict replaces the
 * grader's only when it clears the calibrated floor and fits what the grader
 * cited; otherwise the grader's verdict stands and the grade says why. With
 * the organization's switch off, the decision model is never asked.
 */

import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import type {
  ClaimGrade,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { ListVerificationRunCapError } from "@/api/lib/lists/verification/run-caps";
import {
  decideVerdicts,
  LLM_DECIDER,
  resolveVerdictDecider,
  VERDICT_OUTCOMES,
  VERDICT_STATE_BY_OUTCOME,
} from "@/api/lib/lists/verification/verdict-decider";
import type { VerdictDecider } from "@/api/lib/lists/verification/verdict-decider";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { hasCustomerDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { decisionConfidenceFloor } from "@/api/lib/workflow/decisions/decision-policy";
import { fakeVerdictDecisionModel } from "@/api/tests/helpers/fake-verdict-decision-model";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("organization-fixture");
const workspaceId = toSafeId<"workspace">("workspace-fixture");
const FACT_A = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
const FACT_B = toSafeId<"entity">("22222222-2222-4222-8222-222222222222");

const access = decideFeatureAccess({
  registry: FEATURE_REGISTRY,
  featureId: LIST_VERIFICATION_FEATURE_ID,
  userId: "user-fixture",
  grants: {
    [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
    [LIST_VERIFICATION_FEATURE_ID]: [{ type: "organization", organizationId }],
  },
  organizationId,
  user: { email: "fixture@example.test", emailVerified: true },
  membership: true,
});
if (access.status !== "enabled") {
  throw new Error("Fixture requires access");
}

/** Deps whose usage ledger counts the decision calls it meters. */
const makeDeps = (
  overrides: Partial<VerificationModelDeps> = {},
): { deps: VerificationModelDeps; metered: () => number } => {
  let metered = 0;
  const safeDb = asTestRaw<SafeDb>(async () => {
    metered += 1;
    return await Promise.resolve(Result.ok({ status: "recorded" }));
  });
  return {
    metered: () => metered,
    deps: {
      admission: testModelAdmission(organizationId),
      accessProof: access.proof,
      refreshAccessProof: async () => await Promise.resolve(access.proof),
      checkRunBudget: async () => await Promise.resolve(Result.ok()),
      organizationId,
      workspaceId,
      entityVersionId: toSafeId<"entityVersion">("version-fixture"),
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      promptCachingEnabled: false,
      serviceTier: "standard",
      usageMetering: {
        actionType: "doc_review",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: toSafeId<"user">("user-fixture"),
        workspaceId,
      } satisfies AIUsageMetering,
      abortSignal: AbortSignal.timeout(5000),
      ...overrides,
    },
  };
};

const fact = (
  factEntityId: typeof FACT_A,
  text: string,
): VerificationEvidenceFact => ({
  factEntityId,
  text,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
  sources: [],
});

const FACTS = new Map([
  [
    FACT_A,
    { promptId: "F1", fact: fact(FACT_A, "Invoice 17 paid on 5 April 2021") },
  ],
  [
    FACT_B,
    { promptId: "F2", fact: fact(FACT_B, "Bank statement, April 2021") },
  ],
]);

const SUPPORTED: ClaimGrade = {
  state: "supported",
  score: 84,
  recordConflict: null,
  refs: [{ factEntityId: FACT_A, rel: "supports" }],
  qualifiers: [],
};

const candidate = (grade: ClaimGrade, promptId = "C1") => ({
  promptId,
  claim: "The invoice was paid on 5 April 2021",
  passage: "The invoice was paid on 5 April 2021, as agreed.",
  grade,
});

const decide = async (
  model: DecisionModel,
  grade: ClaimGrade,
  deps = makeDeps().deps,
) =>
  (
    await decideVerdicts({
      decider: { kind: "decision-model", model },
      candidates: [candidate(grade)],
      facts: FACTS,
      deps,
    })
  ).get("C1");

describe("the decision model's outcomes", () => {
  test("each outcome is exactly one claim state, and every state has one", () => {
    const mapped = VERDICT_OUTCOMES.map(
      (outcome) => VERDICT_STATE_BY_OUTCOME[outcome],
    );
    expect(new Set(mapped).size).toBe(VERDICT_OUTCOMES.length);
    expect(new Set(mapped)).toEqual(new Set(CLAIM_STATES));
    expect(Object.keys(VERDICT_STATE_BY_OUTCOME).toSorted()).toEqual(
      [...VERDICT_OUTCOMES].toSorted(),
    );
  });
});

describe("who decides the verdict", () => {
  test("a confident decision model replaces the verdict, records itself and is metered", async () => {
    const jev = fakeVerdictDecisionModel({
      answer: { choice: "refuted", confidence: 0.9 },
    });
    const { deps, metered } = makeDeps();
    const decided = await decide(jev.client, SUPPORTED, deps);
    expect(decided).toEqual({
      state: "contradicted",
      // Refuted at 0.9, the rest even: 0.02 confirmed, 0.02 strained.
      score: 3,
      recordConflict: null,
      refs: SUPPORTED.refs,
      qualifiers: [],
      decider: {
        kind: "decision-model",
        model: "jev-1.14",
        confidence: 0.9,
        replaced: "supported",
      },
    });
    expect(metered()).toBe(1);
    // It read the claim with the facts the grader cited, by their prompt ids.
    expect(JSON.stringify(jev.requests.at(0)?.state)).toContain(
      '"id":"F1","text":"Invoice 17 paid on 5 April 2021","stance":"supports"',
    );
    expect(JSON.stringify(jev.requests.at(0)?.state)).not.toContain("F2");
  });

  test("agreeing with the grader keeps the grader's score", async () => {
    const jev = fakeVerdictDecisionModel({
      answer: { choice: "confirmed", confidence: 0.95 },
    });
    expect(await decide(jev.client, SUPPORTED)).toMatchObject({
      state: "supported",
      score: 84,
      decider: { kind: "decision-model", replaced: "supported" },
    });
  });

  const floor = decisionConfidenceFloor("jev-1.14", "verdict");

  test.each([
    { confidence: floor - 0.01, decided: false },
    { confidence: floor, decided: true },
  ])(
    "at confidence $confidence against the verdict floor, decided: $decided",
    async ({ confidence, decided }) => {
      const jev = fakeVerdictDecisionModel({
        answer: { choice: "refuted", confidence },
      });
      const settled = await decide(jev.client, SUPPORTED);
      expect(settled?.state).toBe(decided ? "contradicted" : "supported");
      expect(settled?.decider).toEqual(
        decided
          ? {
              kind: "decision-model",
              model: "jev-1.14",
              confidence,
              replaced: "supported",
            }
          : {
              kind: "llm",
              fallback: {
                reason: "below-floor",
                model: "jev-1.14",
                confidence,
              },
            },
      );
    },
  );

  test.each(["fail", "throw"] as const)(
    "a decision call that fails (%s) leaves the grader's verdict with the reason",
    async (type) => {
      const jev = fakeVerdictDecisionModel({ answer: { type } });
      const { deps, metered } = makeDeps();
      expect(await decide(jev.client, SUPPORTED, deps)).toEqual({
        ...SUPPORTED,
        decider: {
          kind: "llm",
          fallback: { reason: "failed", model: null, confidence: null },
        },
      });
      expect(jev.requests).toHaveLength(1);
      expect(metered()).toBe(0);
    },
  );

  test("a verdict the grade cannot carry stays with the grader", async () => {
    // A record conflict needs the two records only the grader names.
    const conflict = fakeVerdictDecisionModel({
      answer: { choice: "records-disagree", confidence: 0.99 },
    });
    expect((await decide(conflict.client, SUPPORTED))?.decider).toEqual({
      kind: "llm",
      fallback: { reason: "incompatible", model: "jev-1.14", confidence: 0.99 },
    });
    // A scored verdict needs a cited fact; missing coverage cited none.
    const uncovered: ClaimGrade = {
      state: "nocover",
      score: null,
      recordConflict: null,
      refs: [],
      qualifiers: [],
    };
    const confirmed = fakeVerdictDecisionModel({
      answer: { choice: "confirmed", confidence: 0.99 },
    });
    expect(await decide(confirmed.client, uncovered)).toMatchObject({
      state: "nocover",
      decider: { kind: "llm", fallback: { reason: "incompatible" } },
    });
  });

  test("a qualifier that does not fit the new verdict is dropped", async () => {
    const silent: ClaimGrade = {
      state: "nocover",
      score: null,
      recordConflict: null,
      refs: [{ factEntityId: FACT_B, rel: "record" }],
      qualifiers: [
        { kind: "record-silent", explanation: "Background only." },
        { kind: "scope-mismatch", explanation: "A different month." },
      ],
    };
    const jev = fakeVerdictDecisionModel({
      answer: { choice: "strained", confidence: 0.9 },
    });
    expect(await decide(jev.client, silent)).toMatchObject({
      state: "tension",
      qualifiers: [{ kind: "scope-mismatch" }],
    });
  });

  test("a call the budget does not admit is never sent", async () => {
    const jev = fakeVerdictDecisionModel({
      answer: { choice: "refuted", confidence: 0.99 },
    });
    const { deps } = makeDeps({
      checkRunBudget: async () =>
        await Promise.resolve(
          Result.err(
            new ListVerificationRunCapError({
              message: "Budget reached",
              reason: "daily",
              hint: "Try again tomorrow.",
            }),
          ),
        ),
    });
    expect((await decide(jev.client, SUPPORTED, deps))?.decider).toEqual({
      kind: "llm",
      fallback: { reason: "not-admitted", model: null, confidence: null },
    });
    expect(jev.requests).toHaveLength(0);
  });

  test("switched on without a reachable model, the grade says so", async () => {
    const settled = await decideVerdicts({
      decider: { kind: "decision-model", model: null },
      candidates: [candidate(SUPPORTED)],
      facts: FACTS,
      deps: makeDeps().deps,
    });
    expect(settled.get("C1")?.decider).toEqual({
      kind: "llm",
      fallback: { reason: "no-backend", model: null, confidence: null },
    });
  });
});

const ORG_WITH_DECISION_MODEL = {
  providers: [{ provider: "openai", apiKey: "fixture-key" }],
  overrideModels: null,
  decision: {
    provider: "typesafe",
    apiKey: "fixture-key",
    modelId: "jev-latest",
  },
} satisfies OrgAIConfig;

/** The grader's answer for every claim: supported, citing the first fact. */
const graderSupports = () =>
  asTestRaw<typeof generateTanStackObjectForTask>(
    mock(
      async () =>
        await Promise.resolve({
          grades: [
            {
              claimId: "C1",
              statedDate: null,
              verdict: "supported",
              score: 84,
              refs: [{ factId: "F1", rel: "supports" }],
              conflict: null,
              qualifiers: [],
            },
          ],
        }),
    ),
  );

const gradeOne = async (verdictDecider: VerdictDecider) =>
  await gradeClaims({
    claims: [
      {
        key: "0",
        text: "The invoice was paid on 5 April 2021",
        context: {
          text: "The invoice was paid on 5 April 2021, as agreed.",
          anchor: { start: 0, end: 36 },
        },
        linkedFactIds: [],
      },
    ],
    facts: [...FACTS.values()].map(({ fact: pinned }) => pinned),
    deps: makeDeps({ generateObjectForTask: graderSupports() }).deps,
    verdictDecider,
  });

describe("the organization's switch", () => {
  test("off, the decision model is never resolved or asked; on, it decides", async () => {
    const jev = fakeVerdictDecisionModel({
      answer: { choice: "refuted", confidence: 0.95 },
    });
    const resolveModel = mock(() => jev.client);

    const off = resolveVerdictDecider({
      enabled: false,
      orgAIConfig: ORG_WITH_DECISION_MODEL,
      resolveModel,
    });
    expect(off).toEqual(LLM_DECIDER);
    const offGrade = (await gradeOne(off)).unwrap();
    expect(offGrade.grades.get("0")).toMatchObject({
      state: "supported",
      decider: { kind: "llm", fallback: null },
    });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(jev.requests).toHaveLength(0);

    // The same fixture with the switch on reaches the decision model, so the
    // assertions above are not vacuous.
    const on = resolveVerdictDecider({
      enabled: true,
      orgAIConfig: ORG_WITH_DECISION_MODEL,
      resolveModel,
    });
    const onGrade = (await gradeOne(on)).unwrap();
    expect(jev.requests).toHaveLength(1);
    expect(onGrade.grades.get("0")).toMatchObject({
      state: "contradicted",
      decider: { kind: "decision-model", replaced: "supported" },
    });
  });

  test("an organization on its own generative keys cannot fall back on the instance's decision model", () => {
    const instance = {
      ...fakeVerdictDecisionModel({
        answer: { choice: "confirmed", confidence: 1 },
      }).client,
      keySource: "instance" as const,
    };
    const byok = { ...instance, keySource: "byok" as const };
    const ownKeys = { ...ORG_WITH_DECISION_MODEL, decision: null };
    expect(hasCustomerDecisionModel(null, () => instance)).toBe(true);
    expect(hasCustomerDecisionModel(ownKeys, () => instance)).toBe(false);
    expect(hasCustomerDecisionModel(ORG_WITH_DECISION_MODEL, () => byok)).toBe(
      true,
    );
    expect(hasCustomerDecisionModel(null, () => null)).toBe(false);
  });
});
