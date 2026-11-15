/**
 * The verification engine at its model boundary: claims are anchored to the
 * document's own words, answers that break the verdict rules are sent back
 * once, and what still breaks them is never stored as a finding.
 */

import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { locateQuote } from "@stll/legal-ast/quote-locate";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { ModelDeadlineExceededError } from "@/api/lib/errors/provider-call-error";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import {
  extractClaims,
  EXTRACTION_WINDOW_RETRIES,
} from "@/api/lib/lists/verification/claim-extract";
import {
  gradeClaims,
  GRADING_BATCH_SIZE,
  GRADING_CONCURRENCY,
} from "@/api/lib/lists/verification/claim-grade";
import { gradedClaimType } from "@/api/lib/lists/verification/contract";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  createVerificationCall,
  ListVerificationAccessRevokedError,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { wholeDocumentPassages } from "@/api/lib/lists/verification/paragraph-scope";
import { RECHECKS_PER_REQUEST_MAX } from "@/api/lib/lists/verification/recheck";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { ModelRunCapError } from "@/api/lib/usage/model-run-caps/caps";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
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
const deps: VerificationModelDeps = {
  admission: testModelAdmission(organizationId),
  accessProof: access.proof,
  refreshAccessProof: async () => access.proof,
  checkRunBudget: async () => Result.ok(),
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
  generateObjectForTask:
    asTestRaw<typeof generateTanStackObjectForTask>(generateMock),
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
  generateMock.mockClear();
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
      passages: wholeDocumentPassages([
        { id: "b1", text, source: { type: "docx-block", blockId: "b1" } },
      ]),
      deps,
    });
    expect(Result.isOk(result)).toBe(true);
    expect(
      Result.isOk(result)
        ? result.value.claims.map((claim) => ({
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
    const result = await extractClaims({
      passages: wholeDocumentPassages(BLOCKS),
      deps,
    });
    expect(Result.isOk(result)).toBe(true);
    const claims = Result.isOk(result) ? result.value.claims : [];
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

  test("a call carries a window of text and its neighbours, never the whole document", async () => {
    // About 1 KB a block: a window holds eight, so fifty blocks take seven
    // calls, each sized by its text rather than by a count of blocks.
    const many: VerificationBlock[] = Array.from(
      { length: 50 },
      (_, index) => ({
        id: `b${String(index)}`,
        text: `Block ${String(index)} ${"word ".repeat(200)}`,
        source: { type: "docx-block", blockId: `b${String(index)}` },
      }),
    );
    answers.push(...Array.from({ length: 7 }, () => ({ claims: [] })));
    const result = await extractClaims({
      passages: wholeDocumentPassages(many),
      deps,
    });
    expect(Result.isOk(result) ? result.value : null).toEqual({
      claims: [],
      unread: [],
    });
    expect(captured).toHaveLength(7);
    // Windows run concurrently; read them in document order.
    const askedIds = (call: string) =>
      /these blocks only: (?<ids>[^"\\]+)/u.exec(call)?.groups?.["ids"] ?? "";
    const calls = captured
      .map((call) => JSON.stringify(call.messages))
      .toSorted(
        (a, b) =>
          Number(askedIds(a).split(",")[0]?.slice(1)) -
          Number(askedIds(b).split(",")[0]?.slice(1)),
      );
    const asked = calls.map(askedIds);
    expect(asked.at(0)).toBe("b0, b1, b2, b3, b4, b5, b6, b7");
    expect(asked.at(1)).toBe("b8, b9, b10, b11, b12, b13, b14, b15");
    // Each block is asked about once.
    expect(asked.flatMap((ids) => ids.split(", "))).toEqual(
      many.map((block) => block.id),
    );
    // Neighbours are context, cut to the context budget.
    expect(calls.at(0)).toContain("Block 8 ");
    expect(calls.at(0)).not.toContain("Block 10 ");
    expect(calls.at(1)).toContain("Block 7 ");
    expect(calls.at(1)).not.toContain("Block 5 ");
  });

  test("a page longer than a window is cut into pieces anchored in the whole page", async () => {
    const sentence = "The plan was agreed with the council on 2 April. ";
    // The cut falls in the first 9 KB, so the target is in the second piece.
    const page = `${sentence.repeat(200)}The indemnity was never signed. ${sentence.repeat(50)}`;
    const blocks: VerificationBlock[] = [
      { id: "P3", text: page, source: { type: "pdf-page", pageNumber: 3 } },
    ];
    const target = "The indemnity was never signed";
    answers.push(
      { claims: [] },
      {
        claims: [
          {
            blockId: "P3~2",
            quote: target,
            type: "fact",
            framing: "asserted",
          },
        ],
      },
    );
    const result = await extractClaims({
      passages: wholeDocumentPassages(blocks),
      deps,
    });
    expect(captured).toHaveLength(2);
    const asked = captured.map(
      (call) =>
        /these blocks only: (?<id>P3~\d)/u.exec(JSON.stringify(call.messages))
          ?.groups?.["id"],
    );
    // Windows run concurrently: each piece is asked about once, in any order.
    expect(new Set(asked)).toEqual(new Set(["P3~1", "P3~2"]));
    expect(Result.isOk(result) ? result.value.claims : null).toEqual([
      {
        type: "fact",
        framing: "asserted",
        text: target,
        anchor: {
          type: "pdf-page",
          pageNumber: 3,
          start: page.indexOf(target),
          end: page.indexOf(target) + target.length,
        },
        blockIndex: 0,
      },
    ]);
  });

  test("a cut page cited by its own id reads only the pieces the window asked about", async () => {
    const sentence = "The plan was agreed with the council on 2 April. ";
    const page = sentence.repeat(250);
    const blocks: VerificationBlock[] = [
      { id: "P4", text: page, source: { type: "pdf-page", pageNumber: 4 } },
    ];
    // The words repeat on every line: only the second piece's window
    // answers, citing the page rather than its piece.
    const result = await extractClaims({
      passages: wholeDocumentPassages(blocks),
      deps: {
        ...deps,
        generateObjectForTask: asTestRaw<typeof generateTanStackObjectForTask>(
          async (options: Captured) =>
            await Promise.resolve(
              JSON.stringify(options.messages).includes(
                "these blocks only: P4~2",
              )
                ? {
                    claims: [
                      {
                        blockId: "P4",
                        quote: "The plan was agreed with the council",
                        type: "fact",
                        framing: "asserted",
                      },
                    ],
                  }
                : { claims: [] },
            ),
        ),
      },
    });
    const claims = Result.isOk(result) ? result.value.claims : [];
    expect(claims).toHaveLength(1);
    // Anchored at the start of the second piece, past the first piece's
    // 9 KB, never at the first line of the page.
    expect(claims[0]?.anchor.start).toBeGreaterThan(8000);
    expect(claims[0]?.anchor.start).toBeLessThan(page.length);
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
    const result = await extractClaims({
      passages: wholeDocumentPassages(BLOCKS),
      deps,
    });
    expect(Result.isOk(result) ? result.value : null).toEqual({
      claims: [],
      unread: [],
    });
  });

  test("a paragraph range is read alone and anchored in the whole page", async () => {
    const page =
      "80. Before the range.\n81. Also before.\n82. I agreed the plan on 2 April.\n83. The plan was then published.\n84. After the range.";
    const blocks: VerificationBlock[] = [
      { id: "P5", text: page, source: { type: "pdf-page", pageNumber: 5 } },
    ];
    const start = page.indexOf("82.");
    const end = page.indexOf("84.");
    // The fixture must reach the fault: offsets inside the slice differ from
    // offsets inside the page.
    expect(start).toBeGreaterThan(0);
    answers.push({
      claims: [
        {
          blockId: "P5",
          quote: "The plan was then published",
          type: "fact",
          framing: "asserted",
        },
        {
          blockId: "P5",
          quote: "Before the range",
          type: "fact",
          framing: "asserted",
        },
      ],
    });
    // The second claim is outside the range: the repair round asks again
    // and the model drops it.
    answers.push({ claims: [] });
    const result = await extractClaims({
      passages: [{ block: blocks[0] ?? panic("fixture"), start, end }],
      deps,
    });
    const claims = Result.isOk(result) ? result.value.claims : [];
    expect(claims.map(({ text, anchor }) => ({ text, anchor }))).toEqual([
      {
        text: "The plan was then published",
        anchor: {
          type: "pdf-page",
          pageNumber: 5,
          start: page.indexOf("The plan"),
          end: page.indexOf("The plan") + "The plan was then published".length,
        },
      },
    ]);
    expect(
      claims.map(({ anchor }) => page.slice(anchor.start, anchor.end)),
    ).toEqual(["The plan was then published"]);
    const prompt = JSON.stringify(captured.at(0)?.messages);
    expect(prompt).toContain("82. I agreed the plan");
    expect(prompt).not.toContain("Before the range");
    expect(prompt).not.toContain("After the range");
  });
});

describe("extractClaims when a window's call fails", () => {
  const sentence = "The plan was agreed with the council on 2 April. ";
  /** Two pages of about 7 KB: one window each. */
  const pages: VerificationBlock[] = [1, 2].map((pageNumber) => ({
    id: `P${String(pageNumber)}`,
    text: `Page ${String(pageNumber)} opens. ${sentence.repeat(140)}`,
    source: { type: "pdf-page", pageNumber },
  }));
  const claimOn = (pageNumber: number) => ({
    claims: [
      {
        blockId: `P${String(pageNumber)}`,
        quote: `Page ${String(pageNumber)} opens`,
        type: "fact",
        framing: "asserted",
      },
    ],
  });
  const askedPage = (options: Captured) =>
    JSON.stringify(options.messages).includes("these blocks only: P2") ? 2 : 1;
  const timeout = () => new ModelDeadlineExceededError({ deadlineMs: 120_000 });

  /** Deps whose model answers per page, and a retry wait that only counts. */
  const failing = (
    answer: (page: number, call: number) => unknown,
    budget: VerificationModelDeps["checkRunBudget"] = async () => Result.ok(),
  ) => {
    const calls = new Map<number, number>();
    const waits: number[] = [];
    const run: VerificationModelDeps = {
      ...deps,
      checkRunBudget: budget,
      abortSignal: new AbortController().signal,
      generateObjectForTask: asTestRaw<typeof generateTanStackObjectForTask>(
        async (options: Captured) => {
          const page = askedPage(options);
          const call = (calls.get(page) ?? 0) + 1;
          calls.set(page, call);
          const value = answer(page, call);
          if (value instanceof Error) {
            throw value;
          }
          return await Promise.resolve(value);
        },
      ),
    };
    return {
      calls,
      waits,
      extract: async () =>
        await extractClaims({
          passages: wholeDocumentPassages(pages),
          deps: run,
          waitBeforeRetry: async (attempt) => {
            waits.push(attempt);
            await Promise.resolve();
          },
        }),
    };
  };

  test("a window that times out is called again and read", async () => {
    const model = failing((page, call) =>
      page === 2 && call === 1 ? timeout() : claimOn(page),
    );
    const result = await model.extract();
    expect(
      Result.isOk(result)
        ? {
            claims: result.value.claims.map((claim) => claim.text),
            unread: result.value.unread,
          }
        : null,
    ).toEqual({ claims: ["Page 1 opens", "Page 2 opens"], unread: [] });
    expect(Object.fromEntries(model.calls)).toEqual({ 1: 1, 2: 2 });
    expect(model.waits).toEqual([0]);
  });

  test("a window that keeps failing is reported unread; the rest is still read", async () => {
    const model = failing((page) => (page === 2 ? timeout() : claimOn(page)));
    const result = await model.extract();
    expect(
      Result.isOk(result)
        ? {
            claims: result.value.claims.map((claim) => claim.text),
            unread: result.value.unread,
          }
        : null,
    ).toEqual({
      claims: ["Page 1 opens"],
      unread: [
        {
          start: { blockId: "P2", offset: 0 },
          end: {
            blockId: "P2",
            offset: pages[1]?.text.length ?? panic("fixture"),
          },
        },
      ],
    });
    // The first call and two retries, with a wait before each retry.
    expect(model.calls.get(2)).toBe(1 + EXTRACTION_WINDOW_RETRIES);
    expect(model.waits).toEqual([0, 1]);
  });

  test("a failure no retry can clear is not sent again", async () => {
    const rejected = Object.assign(new Error("Unauthorized"), { status: 401 });
    const model = failing((page) => (page === 2 ? rejected : claimOn(page)));
    const result = await model.extract();
    expect(Result.isOk(result) ? result.value.unread : null).toHaveLength(1);
    expect(model.calls.get(2)).toBe(1);
    expect(model.waits).toEqual([]);
  });

  test("extraction fails when no window could be read", async () => {
    const model = failing(() => timeout());
    const result = await model.extract();
    expect(Result.isError(result)).toBe(true);
    expect(Result.isError(result) ? result.error.cause : null).toBeInstanceOf(
      ModelDeadlineExceededError,
    );
  });

  test("reaching the run's call cap during a retry stops extraction", async () => {
    let checks = 0;
    const capError = new ModelRunCapError({
      kind: "list-run",
      reason: "active",
      message: "Verification limit reached",
      hint: "Wait for an active run.",
    });
    const model = failing(
      (page) => (page === 2 ? timeout() : claimOn(page)),
      async () => {
        checks += 1;
        // Page 1 and page 2's first call pass; the retry is refused.
        return checks <= 2 ? Result.ok() : Result.err(capError);
      },
    );
    const result = await model.extract();
    expect(Result.isError(result) ? result.error.cause : null).toBe(capError);
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
      linkedFactIds: [],
    },
    {
      key: "1",
      text: "The amount was EUR 40,000",
      context: {
        text: "The amount was EUR 40,000 in total.",
        anchor: { start: 0, end: "The amount was EUR 40,000".length },
      },
      linkedFactIds: [],
    },
  ];

  test("a long block supplies passage context around the claim span", async () => {
    const text = "The payment was approved";
    const context = `${"L".repeat(3000)}${text}${"R".repeat(3000)}`;
    answers.push({
      grades: [
        {
          claimId: "C1",
          statedDate: null,
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
          qualifiers: [],
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
          linkedFactIds: [],
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
          statedDate: null,
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
          qualifiers: [],
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
          linkedFactIds: [],
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
            statedDate: null,
            verdict: "supported",
            score: 91.6,
            refs: [{ factId: "F1", rel: "supports" }],
            conflict: null,
            qualifiers: [],
          },
          {
            claimId: "C2",
            statedDate: null,
            verdict: "contradicted",
            score: 20,
            refs: [],
            conflict: null,
            qualifiers: [],
          },
        ],
      },
      {
        grades: [
          {
            claimId: "C2",
            statedDate: null,
            verdict: "contradicted",
            score: 20,
            refs: [{ factId: "F2", rel: "conflicts" }],
            conflict: null,
            qualifiers: [],
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
        qualifiers: [],
      });
      expect(outcome.grades.get("1")?.refs).toEqual([
        { factEntityId: FACT_B, rel: "conflicts" },
      ]);
    }
  });

  test("a claim's words date it; the grader's date counts only where they name none", async () => {
    const answer = (statedDate: string) => ({
      grades: ["C1", "C2"].map((claimId) => ({
        claimId,
        statedDate,
        verdict: "nocover",
        score: null,
        refs: [],
        conflict: null,
        qualifiers: [],
      })),
    });
    answers.push(answer("2020-06"));
    const result = await gradeClaims({
      claims,
      facts: [fact(FACT_A, "Meeting on 9 March 2021")],
      deps,
    });
    const outcome = Result.isOk(result) ? result.value : null;
    expect(
      outcome?.type === "graded" ? [...outcome.assertedDates] : null,
    ).toEqual([
      [
        "0",
        { type: "dated", source: "text", date: "2021-03-09", precision: "day" },
      ],
      [
        "1",
        {
          type: "dated",
          source: "grader",
          date: "2020-06-01",
          precision: "month",
        },
      ],
    ]);

    // A grader date that is not a calendar date is no date.
    answers.push(answer("June 2020"));
    const unreadable = await gradeClaims({
      claims,
      facts: [fact(FACT_A, "Meeting on 9 March 2021")],
      deps,
    });
    const second = Result.isOk(unreadable) ? unreadable.value : null;
    expect(
      second?.type === "graded" ? second.assertedDates.get("1") : null,
    ).toEqual({ type: "none" });
  });

  test("sets aside an uncheckable claim while leaving an uncovered fact checkable", async () => {
    answers.push({
      grades: [
        {
          claimId: "C1",
          statedDate: null,
          verdict: "notverifiable",
          score: null,
          refs: [{ factId: "F1", rel: "record" }],
          conflict: null,
          qualifiers: [],
        },
        {
          claimId: "C2",
          statedDate: null,
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
          qualifiers: [],
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
          linkedFactIds: [],
        },
        {
          key: "fact",
          text: "The payment was approved",
          context: {
            text: "The payment was approved.",
            anchor: { start: 0, end: "The payment was approved".length },
          },
          linkedFactIds: [],
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
        qualifiers: [],
      });
      expect(outcome.grades.get("fact")).toEqual({
        state: "nocover",
        score: null,
        recordConflict: null,
        refs: [],
        qualifiers: [],
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
          statedDate: null,
          verdict: "recordconflict",
          score: null,
          refs: [],
          conflict: {
            subject: "Meeting date",
            factIds: ["F1", "F2"],
            values: ["9 March 2021", "3 May 2021"],
            verdictIfGoverning: ["supported", "contradicted"],
          },
          qualifiers: [],
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
        qualifiers: [],
      },
    );
  });

  test("qualifiers are kept with the verdict they fit", async () => {
    answers.push({
      grades: [
        {
          claimId: "C1",
          statedDate: null,
          verdict: "nocover",
          score: null,
          refs: [],
          conflict: null,
          qualifiers: [
            {
              kind: "record-silent",
              explanation: "  The witness's own impression.  ",
            },
          ],
        },
        {
          claimId: "C2",
          statedDate: null,
          verdict: "tension",
          score: 45,
          refs: [{ factId: "F2", rel: "conflicts" }],
          conflict: null,
          qualifiers: [
            {
              kind: "scope-mismatch",
              explanation: "The fact covers 2020, the claim 2021.",
            },
          ],
        },
      ],
    });
    const result = await gradeClaims({
      claims,
      facts: [
        fact(FACT_A, "Meeting on 9 March 2021"),
        fact(FACT_B, "EUR 30,000 paid in 2020"),
      ],
      deps,
    });
    expect(captured).toHaveLength(1);
    const outcome = Result.isOk(result) ? result.value : null;
    expect(
      outcome?.type === "graded"
        ? [...outcome.grades.values()].map(({ state, qualifiers }) => ({
            state,
            qualifiers,
          }))
        : null,
    ).toEqual([
      {
        state: "nocover",
        qualifiers: [
          {
            kind: "record-silent",
            explanation: "The witness's own impression.",
          },
        ],
      },
      {
        state: "tension",
        qualifiers: [
          {
            kind: "scope-mismatch",
            explanation: "The fact covers 2020, the claim 2021.",
          },
        ],
      },
    ]);
  });

  // Each answer breaks one pairing rule; the repair round names the rule
  // back, and a grade is only ever kept once it holds.
  test.each([
    {
      rule: "record silent beside a verdict other than no coverage",
      qualifiers: [{ kind: "record-silent", explanation: "Background." }],
      reason: "gives record-silent with a contradicted verdict",
    },
    {
      rule: "a qualifier without an explanation",
      qualifiers: [{ kind: "scope-mismatch", explanation: "   " }],
      reason: "gives scope-mismatch without an explanation",
    },
    {
      rule: "the same qualifier twice",
      qualifiers: [
        { kind: "scope-mismatch", explanation: "Another year." },
        { kind: "scope-mismatch", explanation: "Another place." },
      ],
      reason: "gives scope-mismatch more than once",
    },
  ])("repairs $rule", async ({ qualifiers, reason }) => {
    const broken = {
      claimId: "C1",
      statedDate: null,
      verdict: "contradicted",
      score: 10,
      refs: [{ factId: "F1", rel: "conflicts" }],
      conflict: null,
      qualifiers,
    };
    answers.push(
      { grades: [broken] },
      { grades: [{ ...broken, qualifiers: [] }] },
    );
    const result = await gradeClaims({
      claims: claims.slice(0, 1),
      facts: [fact(FACT_A, "Meeting on 9 March 2021")],
      deps,
    });
    expect(captured).toHaveLength(2);
    expect(JSON.stringify(captured.at(1)?.messages)).toContain(
      `- C1: ${reason}`,
    );
    const outcome = Result.isOk(result) ? result.value : null;
    expect(
      outcome?.type === "graded" ? outcome.grades.get("0")?.qualifiers : null,
    ).toEqual([]);
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
      grades: new Map(),
      assertedDates: new Map(),
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
    generateObjectForTask: asTestRaw<typeof generateTanStackObjectForTask>(
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
  const extracted = await extractClaims({
    passages: wholeDocumentPassages(BLOCKS),
    deps: currentDeps,
  });
  expect(Result.isOk(extracted)).toBe(true);
  if (Result.isError(extracted)) {
    throw new TypeError("Expected extracted fixture claim");
  }
  expect(extracted.value.claims).toHaveLength(1);
  const graded = await gradeClaims({
    claims: extracted.value.claims.map((claim, position) => ({
      key: String(position),
      text: claim.text,
      context: {
        text:
          BLOCKS.at(claim.blockIndex)?.text ??
          panic("Expected extracted block"),
        anchor: claim.anchor,
      },
      linkedFactIds: [],
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
      [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
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

test("each model request rechecks its run budget before dispatch", async () => {
  let checks = 0;
  const capError = new ModelRunCapError({
    kind: "list-run",
    reason: "active",
    message: "Verification limit reached",
    hint: "Wait for an active run.",
  });
  const call = createVerificationCall({
    deps: {
      ...deps,
      checkRunBudget: async () => {
        checks += 1;
        return checks === 1 ? Result.ok() : Result.err(capError);
      },
    },
    feature: "verification-budget-test",
    system: "Fixture instruction",
    shared: null,
    outputSchema: v.object({ value: v.string() }),
  });
  answers.push({ value: "fixture" });
  expect(await call.generate([])).toEqual(Result.ok({ value: "fixture" }));
  const refusal = await call.generate([]);
  expect(Result.isError(refusal)).toBe(true);
  if (Result.isError(refusal)) {
    expect(refusal.error).toBe(capError);
  }
  expect(checks).toBe(2);
  expect(captured).toHaveLength(1);
});

test("a bulk re-check request is one round of the grader's batches", () => {
  expect(RECHECKS_PER_REQUEST_MAX).toBe(
    GRADING_BATCH_SIZE * GRADING_CONCURRENCY,
  );
});
