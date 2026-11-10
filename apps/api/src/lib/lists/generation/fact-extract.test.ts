/**
 * Fact extraction at its model boundary: every fact is pinned to the
 * document's own words, a misquote is sent back once, and only a genuinely
 * contested meaning holds a fact back from scoring.
 */

import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import {
  extractFacts,
  parseOccurredOn,
} from "@/api/lib/lists/generation/fact-extract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type Captured = { messages: unknown[] };

const captured: Captured[] = [];
const answers: unknown[] = [];
const generateMock = mock(async (options: Captured) => {
  captured.push(options);
  return await Promise.resolve(answers.shift());
});

beforeEach(() => {
  generateMock.mockClear();
  captured.length = 0;
  answers.length = 0;
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
    text: "On 9 March 2021 the board approved the discharge policy. It was circulated later.",
    source: { type: "docx-block", blockId: "b1" },
  },
  {
    id: "P2",
    text: "I saw the “final” version at the meeting in April 2021.",
    source: { type: "pdf-page", pageNumber: 2 },
  },
];

const rawFact = (overrides: Record<string, unknown>) => ({
  blockId: "b1",
  quote: "the board approved the discharge policy",
  fact: "The board approved the discharge policy on 9 March 2021.",
  occurredOn: "2021-03-09",
  evidenceKind: "document",
  medium: "Board minutes",
  confidence: "high",
  contestedMeaning: null,
  ...overrides,
});

describe("extractFacts", () => {
  test("pins each fact to the located words and repairs a misquote once", async () => {
    answers.push(
      {
        facts: [
          rawFact({}),
          rawFact({
            blockId: "P2",
            quote: "I saw the final version at a meeting",
            fact: "The witness saw the final version at the April 2021 meeting.",
            occurredOn: "2021-04",
            evidenceKind: "testimony",
            medium: "Witness statement",
          }),
        ],
      },
      {
        facts: [
          rawFact({
            blockId: "P2",
            quote: 'I saw the "final" version at the meeting',
            fact: "The witness saw the final version at the April 2021 meeting.",
            occurredOn: "2021-04",
            evidenceKind: "testimony",
            medium: "Witness statement",
          }),
        ],
      },
    );

    const result = await extractFacts({ blocks: BLOCKS, request: null, deps });

    expect(captured).toHaveLength(2);
    const facts = Result.isOk(result) ? result.value : [];
    expect(
      facts.map(({ locator, quote, details }) => ({
        locator,
        quote,
        evidenceKind: details.evidenceKind,
        occurredOn: details.occurredOn,
      })),
    ).toEqual([
      {
        locator: { type: "docx-block", blockId: "b1", start: 16, end: 55 },
        quote: "the board approved the discharge policy",
        evidenceKind: "Document",
        occurredOn: { date: "2021-03-09", precision: "day" },
      },
      {
        // The quote is the document's spelling, curly quotes included.
        locator: { type: "pdf-page", pageNumber: 2, start: 0, end: 40 },
        quote: "I saw the “final” version at the meeting",
        evidenceKind: "Testimony",
        occurredOn: { date: "2021-04-01", precision: "month" },
      },
    ]);
    for (const fact of facts) {
      const block = BLOCKS.find(
        (candidate) =>
          (fact.locator.type === "docx-block" &&
            candidate.id === fact.locator.blockId) ||
          (fact.locator.type === "pdf-page" &&
            candidate.id === `P${String(fact.locator.pageNumber)}`),
      );
      expect(
        "start" in fact.locator
          ? block?.text.slice(fact.locator.start, fact.locator.end)
          : null,
      ).toBe(fact.quote);
    }
  });

  test("one passage can establish two facts, and a repeated fact is listed once", async () => {
    const amount = rawFact({
      fact: "The board approved the discharge policy.",
    });
    const date = rawFact({
      fact: "The discharge policy was approved on 9 March 2021.",
    });
    answers.push({ facts: [amount, date, amount] });

    const result = await extractFacts({ blocks: BLOCKS, request: null, deps });

    expect(
      (Result.isOk(result) ? result.value : []).map(({ name }) => name),
    ).toEqual([
      "The board approved the discharge policy.",
      "The discharge policy was approved on 9 March 2021.",
    ]);
  });

  test("a fact whose quote is still not in the document after repair is dropped", async () => {
    answers.push(
      { facts: [rawFact({ quote: "the board rejected the policy" })] },
      { facts: [rawFact({ quote: "the board rejected the policy" })] },
    );

    const result = await extractFacts({ blocks: BLOCKS, request: null, deps });

    expect(Result.isOk(result) ? result.value : null).toEqual([]);
  });

  test("only a contested meaning holds a fact, with its note", async () => {
    answers.push({
      facts: [
        rawFact({ confidence: "low" }),
        rawFact({
          blockId: "P2",
          quote: "the “final” version",
          fact: "The witness saw the final version of the policy.",
          occurredOn: null,
          evidenceKind: "testimony",
          confidence: "medium",
          contestedMeaning:
            "“Final” may mean the approved policy or the last circulated draft.",
        }),
      ],
    });

    const result = await extractFacts({ blocks: BLOCKS, request: null, deps });

    expect(
      (Result.isOk(result) ? result.value : []).map(({ details }) => ({
        confidence: details.confidence,
        scoring: details.scoring,
        interpretationNote: details.interpretationNote,
      })),
    ).toEqual([
      // A vague fact is still relied on, at low confidence.
      { confidence: "low", scoring: "included", interpretationNote: null },
      {
        confidence: "medium",
        scoring: "held",
        interpretationNote:
          "“Final” may mean the approved policy or the last circulated draft.",
      },
    ]);
  });

  test("the reviewer's request travels as quoted data with each window", async () => {
    answers.push({ facts: [] });

    await extractFacts({
      blocks: BLOCKS,
      request: "Facts about the discharge policy",
      deps,
    });

    expect(JSON.stringify(captured.at(0)?.messages)).toContain(
      String.raw`Reviewer's request: \"Facts about the discharge policy\"`,
    );
  });

  test("a model failure fails the extraction rather than returning a partial list", async () => {
    const revoked = { ...deps, refreshAccessProof: async () => null };
    answers.push({ facts: [rawFact({})] });

    const result = await extractFacts({
      blocks: BLOCKS,
      request: null,
      deps: revoked,
    });

    expect(Result.isError(result)).toBe(true);
    expect(captured).toHaveLength(0);
  });
});

describe("parseOccurredOn", () => {
  test("keeps the precision the document stated", () => {
    expect(parseOccurredOn("2021-07-19")).toEqual({
      date: "2021-07-19",
      precision: "day",
    });
    expect(parseOccurredOn("2021-07")).toEqual({
      date: "2021-07-01",
      precision: "month",
    });
    expect(parseOccurredOn("2021")).toEqual({
      date: "2021-01-01",
      precision: "year",
    });
  });

  test("drops a date that is not a calendar date or not a date at all", () => {
    expect(parseOccurredOn("2021-02-30")).toBeNull();
    expect(parseOccurredOn("2021-13")).toBeNull();
    expect(parseOccurredOn("spring 2021")).toBeNull();
    expect(parseOccurredOn(null)).toBeNull();
  });
});
