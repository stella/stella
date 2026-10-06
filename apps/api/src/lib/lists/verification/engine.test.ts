/**
 * The verification engine at its model boundary: claims are anchored to the
 * document's own words, answers that break the verdict rules are sent back
 * once, and what still breaks them is never stored as a finding.
 */

import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { decideFeatureAccess } from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import {
  gradeClaims,
  gradedClaimType,
} from "@/api/lib/lists/verification/claim-grade";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  createVerificationCall,
  ListVerificationAccessRevokedError,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { locateQuote } from "@/api/lib/lists/verification/quote-locate";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type Captured = { tenantWorkspaceIds: readonly string[]; messages: unknown[] };

const captured: Captured[] = [];
const answers: unknown[] = [];
const generateMock = mock(async (options: Captured) => {
  captured.push(options);
  return await Promise.resolve(answers.shift());
});

const organizationId = toSafeId<"organization">("organization-fixture");
const workspaceId = toSafeId<"workspace">("workspace-fixture");
const safeDb: SafeDb = async () => {
  throw new Error("safeDb should not be called by this test");
};

const access = decideFeatureAccess({
  registry: FEATURE_REGISTRY,
  featureId: LIST_VERIFICATION_FEATURE_ID,
  userId: "user-fixture",
  grants: {
    [LIST_VERIFICATION_FEATURE_ID]: [{ type: "organization", organizationId }],
  },
  organizationId,
  user: { email: "fixture@example.test", emailVerified: true },
  membership: true,
});
if (access.status !== "enabled") {
  throw new Error("Fixture requires access");
}
const deps: VerificationModelDeps = {
  accessProof: access.proof,
  refreshAccessProof: async () => access.proof,
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
  abortSignal: AbortSignal.timeout(1000),
  generateObjectForRole:
    asTestRaw<typeof generateTanStackObjectForRole>(generateMock),
};

const BLOCKS: VerificationBlock[] = [
  {
    id: "b1",
    text: "I first met him on 9 March 2021. We spoke briefly.",
    source: { type: "docx-block", blockId: "b1" },
  },
  {
    id: "P2",
    text: "The payment of “EUR 40,000” was proper.",
    source: { type: "pdf-page", pageNumber: 2 },
  },
];

const FACT_A = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
const FACT_B = toSafeId<"entity">("22222222-2222-4222-8222-222222222222");

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

beforeEach(() => {
  captured.length = 0;
  answers.length = 0;
});

describe("locateQuote", () => {
  test("finds exact words and advances past earlier matches", () => {
    const text = "paid on time; paid on time again";
    expect(locateQuote(text, "paid on time")).toEqual({ start: 0, end: 12 });
    expect(locateQuote(text, "paid on time", 12)).toEqual({
      start: 14,
      end: 26,
    });
  });

  test("matches straightened quotes and collapsed spaces, in original offsets", () => {
    const text = "The payment of “EUR 40,000” was proper.";
    const span = locateQuote(text, 'payment of "EUR 40,000" was');
    expect(span).not.toBeNull();
    expect(text.slice(span?.start, span?.end)).toBe(
      "payment of “EUR 40,000” was",
    );
  });

  test("a paraphrase is not a quote", () => {
    expect(
      locateQuote("I first met him in March.", "I met him in March"),
    ).toBeNull();
  });
});

describe("extractClaims", () => {
  test("repeated statements with equivalent whitespace keep distinct anchors", async () => {
    const text = "paid on time; paid\ton time again";
    const raw = {
      blockId: "b1",
      quote: "paid on time",
      type: "fact",
      framing: "asserted",
    } as const;
    answers.push({ claims: [raw, raw] });
    const result = await extractClaims({
      blocks: [
        { id: "b1", text, source: { type: "docx-block", blockId: "b1" } },
      ],
      deps,
    });
    expect(Result.isOk(result)).toBe(true);
    expect(
      Result.isOk(result)
        ? result.value.map((claim) => ({
            text: claim.text,
            anchor: claim.anchor,
          }))
        : null,
    ).toEqual([
      {
        text: "paid on time",
        anchor: { type: "docx-block", blockId: "b1", start: 0, end: 12 },
      },
      {
        text: "paid\ton time",
        anchor: { type: "docx-block", blockId: "b1", start: 14, end: 26 },
      },
    ]);
    expect(captured).toHaveLength(1);
  });

  test("anchors claims to block offsets and repairs a misquote once", async () => {
    answers.push(
      {
        claims: [
          {
            blockId: "b1",
            quote: "I first met him on 9 March 2021",
            type: "fact",
            framing: "asserted",
          },
          {
            blockId: "P2",
            quote: "the payment was proper",
            type: "opinion",
            framing: "asserted",
          },
        ],
      },
      {
        claims: [
          {
            blockId: "P2",
            quote: 'The payment of "EUR 40,000" was proper',
            type: "opinion",
            framing: "asserted",
          },
        ],
      },
    );
    const result = await extractClaims({ blocks: BLOCKS, deps });
    expect(Result.isOk(result)).toBe(true);
    const claims = Result.isOk(result) ? result.value : [];
    expect(captured).toHaveLength(2);
    expect(
      captured.every((call) => call.tenantWorkspaceIds.includes(workspaceId)),
    ).toBe(true);
    expect(claims.map((claim) => claim.anchor)).toEqual([
      { type: "docx-block", blockId: "b1", start: 0, end: 31 },
      { type: "pdf-page", pageNumber: 2, start: 0, end: 38 },
    ]);
    expect(claims.at(0)?.text).toBe("I first met him on 9 March 2021");
  });

  test("a call carries its window and neighbours, never the whole document", async () => {
    const many: VerificationBlock[] = Array.from(
      { length: 50 },
      (_, index) => ({
        id: `b${String(index)}`,
        text: `Block ${String(index)} text.`,
        source: { type: "docx-block", blockId: `b${String(index)}` },
      }),
    );
    answers.push({ claims: [] }, { claims: [] });
    await extractClaims({ blocks: many, deps });
    expect(captured).toHaveLength(2);
    const firstCall = JSON.stringify(captured.at(0)?.messages);
    expect(firstCall).toContain("Block 42 text.");
    expect(firstCall).not.toContain("Block 43 text.");
    const secondCall = JSON.stringify(captured.at(1)?.messages);
    expect(secondCall).toContain("Block 37 text.");
    expect(secondCall).not.toContain("Block 36 text.");
  });

  test("a claim that cannot be found after repair is left out", async () => {
    answers.push(
      {
        claims: [
          {
            blockId: "nope",
            quote: "anything",
            type: "fact",
            framing: "asserted",
          },
        ],
      },
      { claims: [] },
    );
    const result = await extractClaims({ blocks: BLOCKS, deps });
    expect(Result.isOk(result) ? result.value : null).toEqual([]);
  });
});

describe("gradeClaims", () => {
  const claims = [
    {
      key: "0",
      text: "I first met him on 9 March 2021",
      context: {
        text: "I first met him on 9 March 2021. We spoke briefly.",
        anchor: { start: 0, end: "I first met him on 9 March 2021".length },
      },
    },
    {
      key: "1",
      text: "The amount was EUR 40,000",
      context: {
        text: "The amount was EUR 40,000 in total.",
        anchor: { start: 0, end: "The amount was EUR 40,000".length },
      },
    },
  ];

  test("a long block supplies passage context around the claim span", async () => {
    const text = "The payment was approved";
    const context = `${"L".repeat(3000)}${text}${"R".repeat(3000)}`;
    answers.push({
      grades: [
        {
          claimId: "C1",
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
        },
      ],
    });
    const result = await gradeClaims({
      claims: [
        {
          key: "late",
          text,
          context: {
            text: context,
            anchor: { start: 3000, end: 3000 + text.length },
          },
        },
      ],
      facts: [fact(FACT_A, "An unrelated meeting")],
      deps,
    });
    expect(Result.isOk(result)).toBe(true);
    expect(captured).toHaveLength(1);
    const sent = JSON.stringify(captured.at(0)?.messages);
    expect(sent).toContain(
      `passage: ${"L".repeat(738)}${text}${"R".repeat(738)}`,
    );
    expect(sent).not.toContain(`passage: ${"L".repeat(1500)}`);
  });

  test("short block passage text stays byte-identical at the grading boundary", async () => {
    const text = "EUR 40,000";
    const context = "The payment of “EUR 40,000” was proper.";
    const start = context.indexOf(text);
    answers.push({
      grades: [
        {
          claimId: "C1",
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
        },
      ],
    });
    const result = await gradeClaims({
      claims: [
        {
          key: "short",
          text,
          context: {
            text: context,
            anchor: { start, end: start + text.length },
          },
        },
      ],
      facts: [fact(FACT_A, "An unrelated meeting")],
      deps,
    });
    expect(Result.isOk(result)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured.at(0)?.messages)).toContain(
      `passage: ${context}`,
    );
  });

  test("a list with no facts answers no coverage without a model call", async () => {
    const result = await gradeClaims({ claims, facts: [], deps });
    expect(captured).toHaveLength(0);
    const outcome = Result.isOk(result) ? result.value : null;
    expect(outcome?.type).toBe("graded");
    if (outcome?.type === "graded") {
      expect([...outcome.grades.values()].map((grade) => grade.state)).toEqual([
        "nocover",
        "nocover",
      ]);
    }
  });

  test("a scored verdict must cite a fact; the repair answer is kept", async () => {
    answers.push(
      {
        grades: [
          {
            claimId: "C1",
            verdict: "supported",
            score: 91.6,
            refs: [{ factId: "F1", rel: "supports" }],
            conflict: null,
          },
          {
            claimId: "C2",
            verdict: "contradicted",
            score: 20,
            refs: [],
            conflict: null,
          },
        ],
      },
      {
        grades: [
          {
            claimId: "C2",
            verdict: "contradicted",
            score: 20,
            refs: [{ factId: "F2", rel: "conflicts" }],
            conflict: null,
          },
        ],
      },
    );
    const result = await gradeClaims({
      claims,
      facts: [
        fact(FACT_A, "Meeting on 9 March 2021"),
        fact(FACT_B, "EUR 30,000 paid"),
      ],
      deps,
    });
    expect(captured).toHaveLength(2);
    const outcome = Result.isOk(result) ? result.value : null;
    expect(outcome?.type).toBe("graded");
    if (outcome?.type === "graded") {
      expect(outcome.grades.get("0")).toEqual({
        state: "supported",
        score: 92,
        recordConflict: null,
        refs: [{ factEntityId: FACT_A, rel: "supports" }],
      });
      expect(outcome.grades.get("1")?.refs).toEqual([
        { factEntityId: FACT_B, rel: "conflicts" },
      ]);
    }
  });

  test("sets aside an uncheckable claim while leaving an uncovered fact checkable", async () => {
    answers.push({
      grades: [
        {
          claimId: "C1",
          verdict: "notverifiable",
          score: null,
          refs: [{ factId: "F1", rel: "record" }],
          conflict: null,
        },
        {
          claimId: "C2",
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
        },
      ],
    });
    const result = await gradeClaims({
      claims: [
        {
          key: "opinion",
          text: "The arrangement was proper",
          context: {
            text: "The arrangement was proper.",
            anchor: { start: 0, end: "The arrangement was proper".length },
          },
        },
        {
          key: "fact",
          text: "The payment was approved",
          context: {
            text: "The payment was approved.",
            anchor: { start: 0, end: "The payment was approved".length },
          },
        },
      ],
      facts: [fact(FACT_A, "An unrelated meeting took place")],
      deps,
    });
    const outcome = Result.isOk(result) ? result.value : null;
    expect(outcome?.type).toBe("graded");
    if (outcome?.type === "graded") {
      expect(outcome.grades.get("opinion")).toEqual({
        state: "notverifiable",
        score: null,
        recordConflict: null,
        refs: [],
      });
      expect(outcome.grades.get("fact")).toEqual({
        state: "nocover",
        score: null,
        recordConflict: null,
        refs: [],
      });
      // Stored types must match the verdicts: only a fact is checkable.
      const types = [...outcome.grades.values()].map(gradedClaimType);
      expect(types).toEqual(["unverifiable", "fact"]);
    }
  });

  test("a record conflict names two different facts and a verdict under each", async () => {
    answers.push({
      grades: [
        {
          claimId: "C1",
          verdict: "recordconflict",
          score: null,
          refs: [],
          conflict: {
            subject: "Meeting date",
            factIds: ["F1", "F2"],
            values: ["9 March 2021", "3 May 2021"],
            verdictIfGoverning: ["supported", "contradicted"],
          },
        },
      ],
    });
    const result = await gradeClaims({
      claims: claims.slice(0, 1),
      facts: [fact(FACT_A, "Diary: 9 March"), fact(FACT_B, "Email: 3 May")],
      deps,
    });
    const outcome = Result.isOk(result) ? result.value : null;
    expect(outcome?.type === "graded" ? outcome.grades.get("0") : null).toEqual(
      {
        state: "recordconflict",
        score: null,
        recordConflict: {
          subject: "Meeting date",
          factEntityIds: [FACT_A, FACT_B],
          values: ["9 March 2021", "3 May 2021"],
          governingStates: ["supported", "contradicted"],
        },
        refs: [],
      },
    );
  });

  test("a claim still unanswered after repair makes the grading incomplete", async () => {
    answers.push({ grades: [] }, { grades: [] });
    const result = await gradeClaims({
      claims: claims.slice(0, 1),
      facts: [fact(FACT_A, "Meeting on 9 March 2021")],
      deps,
    });
    expect(Result.isOk(result) ? result.value : null).toEqual({
      type: "incomplete",
      ungraded: 1,
    });
  });
});

test("each model request refreshes its access proof before dispatch", async () => {
  let refreshCount = 0;
  const call = createVerificationCall({
    deps: {
      ...deps,
      refreshAccessProof: async () => {
        refreshCount += 1;
        return refreshCount === 1 ? access.proof : null;
      },
    },
    feature: "verification-test",
    system: "Fixture instruction",
    shared: null,
    outputSchema: v.object({ value: v.string() }),
  });
  answers.push({ value: "fixture" });
  expect(await call.generate([])).toEqual(Result.ok({ value: "fixture" }));
  const denied = await call.generate([]);
  expect(Result.isError(denied) ? denied.error : null).toBeInstanceOf(
    ListVerificationAccessRevokedError,
  );
  expect(refreshCount).toBe(2);
  expect(captured).toHaveLength(1);
});

test("access removal after extraction blocks the later grading batch", async () => {
  let currentProof: VerificationModelDeps["accessProof"] | null = access.proof;
  const dispatched: string[] = [];
  const currentDeps: VerificationModelDeps = {
    ...deps,
    refreshAccessProof: async () => currentProof,
    generateObjectForRole: asTestRaw<typeof generateTanStackObjectForRole>(
      async () => {
        dispatched.push("extraction");
        currentProof = null;
        return {
          claims: [
            {
              blockId: "b1",
              quote: "I first met him on 9 March 2021",
              type: "fact",
              framing: "asserted",
            },
          ],
        };
      },
    ),
  };
  const extracted = await extractClaims({ blocks: BLOCKS, deps: currentDeps });
  expect(Result.isOk(extracted)).toBe(true);
  if (Result.isError(extracted)) {
    throw new TypeError("Expected extracted fixture claim");
  }
  expect(extracted.value).toHaveLength(1);
  const graded = await gradeClaims({
    claims: extracted.value.map((claim, position) => ({
      key: String(position),
      text: claim.text,
      context: {
        text:
          BLOCKS.at(claim.blockIndex)?.text ??
          panic("Expected extracted block"),
        anchor: claim.anchor,
      },
    })),
    facts: [fact(FACT_A, "The meeting took place on 9 March 2021")],
    deps: currentDeps,
  });
  expect(Result.isError(graded) ? graded.error.cause : null).toBeInstanceOf(
    ListVerificationAccessRevokedError,
  );
  expect(dispatched).toEqual(["extraction"]);
});

test("deployment disablement stops a later model request with a valid current proof", async () => {
  const previousDeployment = env.FEATURE_LEGAL_LISTS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  const call = createVerificationCall({
    deps,
    feature: "verification-test",
    system: "Fixture instruction",
    shared: null,
    outputSchema: v.object({ value: v.string() }),
  });
  try {
    env.FEATURE_LEGAL_LISTS = true;
    answers.push({ value: "fixture" });
    expect(await call.generate([])).toEqual(Result.ok({ value: "fixture" }));
    env.FEATURE_LEGAL_LISTS = false;
    const denied = await call.generate([]);
    expect(Result.isError(denied) ? denied.error : null).toBeInstanceOf(
      ListVerificationAccessRevokedError,
    );
    expect(captured).toHaveLength(1);
  } finally {
    env.FEATURE_LEGAL_LISTS = previousDeployment;
    restoreMode();
  }
});

test("a retained proof requires current admission before model dispatch", async () => {
  const call = createVerificationCall({
    deps: { ...deps, refreshAccessProof: async () => null },
    feature: "verification-test",
    system: "Fixture instruction",
    shared: null,
    outputSchema: v.object({ value: v.string() }),
  });
  const denied = await call.generate([]);
  expect(Result.isError(denied) ? denied.error : null).toBeInstanceOf(
    ListVerificationAccessRevokedError,
  );
  expect(captured).toHaveLength(0);
});

test("model dispatch requires proofs bound to the requester and organization", async () => {
  const other = decideFeatureAccess({
    registry: FEATURE_REGISTRY,
    grants: {
      [LIST_VERIFICATION_FEATURE_ID]: [
        { type: "organization", organizationId },
      ],
    },
    featureId: LIST_VERIFICATION_FEATURE_ID,
    organizationId,
    userId: "another-user-fixture",
    user: { email: "another@example.test", emailVerified: true },
    membership: true,
  });
  if (other.status !== "enabled") {
    throw new Error("Fixture requires access");
  }
  for (const accessProof of [access.proof, other.proof]) {
    const call = createVerificationCall({
      deps: {
        ...deps,
        accessProof,
        refreshAccessProof: async () => other.proof,
      },
      feature: "verification-test",
      system: "Fixture instruction",
      shared: null,
      outputSchema: v.object({ value: v.string() }),
    });
    const denied = await call.generate([]);
    expect(Result.isError(denied) ? denied.error : null).toBeInstanceOf(
      ListVerificationAccessRevokedError,
    );
  }
  expect(captured).toHaveLength(0);
});
