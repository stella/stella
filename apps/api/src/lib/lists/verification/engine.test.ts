/**
 * The verification engine at its model boundary: claims are anchored to the
 * document's own words, answers that break the verdict rules are sent back
 * once, and what still breaks them is never stored as a finding.
 */

import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { locateQuote } from "@/api/lib/lists/verification/quote-locate";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
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

const deps: VerificationModelDeps = {
  organizationId,
  workspaceId,
  entityVersionId: toSafeId<"entityVersion">("version-fixture"),
  orgAIConfig: null,
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
      context: "I first met him on 9 March 2021. We spoke briefly.",
    },
    {
      key: "1",
      text: "The amount was EUR 40,000",
      context: "The amount was EUR 40,000 in total.",
    },
  ];

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
