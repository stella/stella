import type { AnyTextAdapter } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FailureGrade, FailureReason } from "@stll/errors";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  answerWithSystemOne,
  ResearchPassageRetrievalError,
  retrieveResearchPassages,
  selectDecisionPassages,
} from "@/api/lib/case-law/research-answer-runner";
import type { ResearchRunColumn } from "@/api/lib/case-law/research-answer-runner";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import type {
  CorpusIndexClient,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
import { CorpusIndexGroupNotReadyError } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import type { ServingCorpusIndexTarget } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const decision = {
  id: toSafeId<"caseLawDecision">("synthetic-decision"),
  country: "AUT",
};
const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
const readTarget = corpusIndexReadTarget({
  manifest,
  jurisdiction: decision.country,
  attestedGroups: new Set(),
  enrolledGroups: new Set(),
});
if (readTarget.type !== "ready") {
  panic("The test jurisdiction must use an attested base group");
}
const servingTarget = {
  ...readTarget.target,
  manifest,
  serving: {
    family: manifest.family,
    generation: manifest.generation,
    cluster: manifest.cluster,
  },
} satisfies ServingCorpusIndexTarget;
const APPLIED_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "6f1c2a3e-8b4d-4c1e-9a2b-3c4d5e6f7a8b",
);
const readyDb = asTestRaw<CaseLawPublicReadDb>(async () =>
  Result.ok({ ...servingTarget, appliedRevision: APPLIED_REVISION }),
);
const emptySearch: CorpusIndexClient["search"] = async () =>
  Result.ok({ numHits: 0, hits: [], snippets: [] });
const clientForSearch = (search: CorpusIndexClient["search"]) =>
  asTestRaw<typeof getCorpusIndexClient>(() => ({ search }));

const failurePaths = {
  "index-not-ready": {
    grade: "anticipated",
    failureReason: "research_index_not_ready",
    paths: [
      {
        name: "a refused serving target",
        caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () =>
          Result.err(
            new CorpusIndexGroupNotReadyError({
              message: "Synthetic pending group",
              indexId: servingTarget.route.indexId,
              reason: "pending",
            }),
          ),
        ),
        clientForCluster: clientForSearch(emptySearch),
      },
    ],
  },
  "target-unavailable": {
    grade: "defect",
    failureReason: "research_passage_target_failed",
    paths: [
      {
        name: "a rejected serving read",
        caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () => {
          throw new TypeError("Synthetic serving read failure");
        }),
        clientForCluster: clientForSearch(emptySearch),
      },
    ],
  },
  "search-failed": {
    grade: "defect",
    failureReason: "research_passage_search_failed",
    paths: [
      {
        name: "a returned search error",
        caseLawDb: readyDb,
        clientForCluster: clientForSearch(async () =>
          Result.err(
            new CorpusIndexError({ message: "Synthetic search error" }),
          ),
        ),
      },
      {
        name: "a rejected search",
        caseLawDb: readyDb,
        clientForCluster: clientForSearch(async () => {
          throw new TypeError("Synthetic search rejection");
        }),
      },
      {
        name: "a rejected client resolution",
        caseLawDb: readyDb,
        clientForCluster: () => panic("Synthetic client resolution failure"),
      },
    ],
  },
} satisfies Record<
  ResearchPassageRetrievalError["reason"],
  {
    grade: FailureGrade;
    failureReason: FailureReason;
    paths: readonly {
      name: string;
      caseLawDb: CaseLawPublicReadDb;
      clientForCluster: typeof getCorpusIndexClient;
    }[];
  }
>;

let logs: RecordingLogger;
let analytics: RecordingAnalytics;
beforeEach(() => {
  logs = installRecordingLogger();
  analytics = installRecordingAnalytics();
  resetFailureObservationsForTesting();
});
afterEach(() => {
  logs.restore();
  analytics.restore();
  resetFailureObservationsForTesting();
});

describe("research passage retrieval", () => {
  test.each(
    Object.entries(failurePaths).flatMap(
      ([reason, { grade, failureReason, paths }]) =>
        paths.map((path) => ({ ...path, reason, grade, failureReason })),
    ),
  )(
    "reports $name without presenting it as an empty search",
    async ({ caseLawDb, clientForCluster, reason, grade, failureReason }) => {
      const result = await retrieveResearchPassages({
        decision,
        questions: [{ question: "synthetic question" }],
        caseLawDb,
        clientForCluster,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(ResearchPassageRetrievalError.is(result.error)).toBe(true);
        expect(reason).toBe(result.error.reason);
      }
      const failures = logs.records.filter(
        ({ message }) =>
          message === "case_law.research_passage_retrieval_failed",
      );
      expect(failures).toHaveLength(1);
      expect(failures.at(0)?.severityText).toBe(
        grade === "defect" ? "ERROR" : "WARN",
      );
      expect(failures.at(0)?.attributes).toMatchObject({
        decisionId: decision.id,
        jurisdiction: decision.country,
        stage: reason,
        "failure.grade": grade,
        "failure.reason": failureReason,
      });
      expect(analytics.exceptions()).toHaveLength(grade === "defect" ? 1 : 0);
      expect(
        selectDecisionPassages({
          fallback: [{ anchorId: "text", excerpt: "Synthetic fallback" }],
          retrieved: result.unwrapOr([]),
          retrievalFailed: result.isErr(),
          budgetChars: 100,
          courtParagraphNumbers: new Map(),
        }),
      ).toMatchObject({
        kind: "passages",
        retrieved: false,
        retrievalFailed: true,
      });
    },
  );

  test("an answered empty search has no failure report", async () => {
    const result = await retrieveResearchPassages({
      decision,
      questions: [{ question: "synthetic question" }],
      caseLawDb: readyDb,
      clientForCluster: clientForSearch(emptySearch),
    });
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
    expect(logs.records).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("an empty query does not read a serving target or client", async () => {
    const result = await retrieveResearchPassages({
      decision,
      questions: [],
      caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () =>
        panic("An empty query must not read a target"),
      ),
      clientForCluster: () => panic("An empty query must not resolve a client"),
    });
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
    expect(logs.records).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("ranked hits keep their order and the bounded decision query", async () => {
    const result = await retrieveResearchPassages({
      decision,
      questions: [{ question: "synthetic question" }],
      caseLawDb: readyDb,
      clientForCluster: clientForSearch(async (input) => {
        expect(input.indexId).toBe(servingTarget.route.indexId);
        // Only the applied revision's copy may answer: a superseded copy of
        // the same decision stays in the index until its delete applies.
        expect(input.query).toStartWith(
          `(document_id:"synthetic-decision" AND projection_revision:"${APPLIED_REVISION}") AND `,
        );
        expect(input.sortBy).toBe("_score");
        return Result.ok({
          numHits: 2,
          hits: [
            { anchor_id: "second", text: "Most relevant" },
            { anchor_id: "first", text: "Next relevant" },
          ],
          snippets: [],
        });
      }),
    });
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([
      { anchorId: "second", excerpt: "Most relevant" },
      { anchorId: "first", excerpt: "Next relevant" },
    ]);
    expect(logs.records).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("a decision without a current revision reads no passages", async () => {
    const result = await retrieveResearchPassages({
      decision,
      questions: [{ question: "synthetic question" }],
      caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () =>
        Result.ok({ ...servingTarget, appliedRevision: null }),
      ),
      clientForCluster: () =>
        panic("A decision with no current revision must not be searched"),
    });
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
    expect(logs.records).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });
});

describe("selectDecisionPassages", () => {
  test("does not mark the over-budget fallback as retrieved when search has no hits", () => {
    const passages = [{ anchorId: "b1", excerpt: "The fallback passage." }];

    expect(
      selectDecisionPassages({
        fallback: passages,
        retrieved: [],
        retrievalFailed: false,
        budgetChars: 100,
        courtParagraphNumbers: new Map(),
      }),
    ).toEqual({
      kind: "passages",
      passages,
      retrieved: false,
      retrievalFailed: false,
      courtParagraphNumbers: new Map(),
    });
  });

  test("carries a failed retrieval forward so later stages do not retry it", () => {
    const passages = [{ anchorId: "b1", excerpt: "The fallback passage." }];

    expect(
      selectDecisionPassages({
        fallback: passages,
        retrieved: [],
        retrievalFailed: true,
        budgetChars: 100,
        courtParagraphNumbers: new Map(),
      }),
    ).toEqual({
      kind: "passages",
      passages,
      retrieved: false,
      retrievalFailed: true,
      courtParagraphNumbers: new Map(),
    });
  });

  test("marks passages as retrieved only when the index supplied them, keeping the decision's court numbers", () => {
    const retrieved = [{ anchorId: "b2", excerpt: "A ranked passage." }];
    // The index hit names only its anchor; its number comes from the AST.
    const courtParagraphNumbers = new Map([["b2", 4]]);

    expect(
      selectDecisionPassages({
        fallback: [{ anchorId: "b1", excerpt: "The full text." }],
        retrieved,
        retrievalFailed: false,
        budgetChars: 100,
        courtParagraphNumbers,
      }),
    ).toEqual({
      kind: "passages",
      passages: retrieved,
      retrieved: true,
      retrievalFailed: false,
      courtParagraphNumbers,
    });
  });
});

test("a mixed research run sends only planned typed questions to its generative fallback", async () => {
  const organizationId = toSafeId<"organization">("org-mixed-research");
  const typedQuestion = {
    columnId: toSafeId<"caseLawResearchColumn">("col-typed"),
    question: "TYPED_QUESTION_PURCHASE_KIND",
    content: {
      version: 1,
      type: "single-select",
      options: [{ value: "Purchase agreement", color: "gray" }],
      fallback: null,
    },
  } satisfies ResearchRunColumn;
  const textQuestion = {
    columnId: toSafeId<"caseLawResearchColumn">("col-text"),
    question: "TEXT_QUESTION_MUST_USE_NORMAL_GENERATION",
    content: { version: 1, type: "text" },
  } satisfies ResearchRunColumn;
  const unplannedQuestion = {
    columnId: toSafeId<"caseLawResearchColumn">("col-unplanned-date"),
    question: "UNPLANNED_DATE_MUST_USE_NORMAL_GENERATION",
    content: { version: 1, type: "date" },
  } satisfies ResearchRunColumn;
  const requests: string[] = [];
  const output = {
    answers: [
      {
        id: "col-typed:value",
        answer: {
          type: "choice",
          choice: "o1",
          probabilities: { o1: 1, __not_stated: 0 },
          confidence: 1,
        },
        evidence: "The text describes a purchase agreement.",
      },
      {
        id: "col-typed:where",
        answer: {
          type: "choice",
          choice: "b1",
          probabilities: { b1: 1, __none: 0 },
          confidence: 1,
        },
        evidence: null,
      },
    ],
  };
  const adapter = {
    ...createScriptedTextAdapter([]),
    structuredOutput: async ({ chatOptions }) => {
      requests.push(JSON.stringify(chatOptions));
      return { data: output, rawText: JSON.stringify(output) };
    },
  } satisfies AnyTextAdapter;
  const model = {
    adapter,
    keySource: "byok",
    modelId: "test-model",
    provider: "openai",
    modelOptions: {},
  } as const satisfies ResolvedTanStackTextModel;
  const run = await answerWithSystemOne({
    decision: {
      ...decision,
      caseNumber: "synthetic-case",
      court: "synthetic-court",
      language: "en",
      decisionType: null,
    },
    questions: [typedQuestion, textQuestion, unplannedQuestion],
    text: {
      passages: [
        {
          anchorId: "b1",
          excerpt:
            "The full source describes a purchase agreement without a date.",
        },
      ],
      retrieved: false,
      retrievalFailed: false,
      courtParagraphNumbers: new Map([["b1", 14]]),
    },
    orgAIConfig: null,
    decisionModel: null,
    caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () =>
      panic("Short source must not trigger retrieval"),
    ),
    usageMetering: {
      actionType: "case_law",
      organizationId,
      userId: toSafeId<"user">("user-mixed-research"),
      workspaceId: null,
      serviceTier: "standard",
      safeDb: asTestRaw<SafeDb>(async () =>
        panic("A fake BYOK generator must not access the ledger"),
      ),
    },
    generation: (prompt) => ({
      dataClass: "customer",
      task: "short-text",
      userId: toSafeId<"user">("user-mixed-research"),
      orgAIConfig: null,
      managedAIResidency: "eu",
      organizationId,
      admission: testModelAdmission(organizationId),
      tenantWorkspaceIds: [],
      serviceTier: "standard",
      caching: { enabled: false, reason: "org-disabled" },
      prompt,
      resolveTextModel: () => model,
    }),
  });
  expect(requests).toHaveLength(1);
  const request = requests.at(0);
  expect(request).toContain(typedQuestion.question);
  expect(request).toContain(
    "The full source describes a purchase agreement without a date.",
  );
  expect(request).not.toContain(textQuestion.question);
  expect(request).not.toContain(unplannedQuestion.question);
  expect(run.remaining).toEqual([textQuestion, unplannedQuestion]);
  expect(run.outcomes).toMatchObject([
    {
      columnId: typedQuestion.columnId,
      outcome: {
        state: "answered",
        run: {
          model: "test-model",
          justification: {
            blocks: [{ anchorId: "b1", courtParagraphNumber: 14 }],
          },
        },
      },
    },
  ]);
});
