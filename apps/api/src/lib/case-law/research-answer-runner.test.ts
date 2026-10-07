import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FailureGrade, FailureReason } from "@stll/errors";

import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  ResearchPassageRetrievalError,
  retrieveResearchPassages,
  selectDecisionPassages,
} from "@/api/lib/case-law/research-answer-runner";
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
const readyDb = asTestRaw<CaseLawPublicReadDb>(async () =>
  Result.ok(servingTarget),
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
        expect(result.error.reason).toBe(reason);
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
        expect(input.query).toContain('document_id:"synthetic-decision"');
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
      }),
    ).toEqual({
      kind: "passages",
      passages,
      retrieved: false,
      retrievalFailed: false,
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
      }),
    ).toEqual({
      kind: "passages",
      passages,
      retrieved: false,
      retrievalFailed: true,
    });
  });

  test("marks passages as retrieved only when the index supplied them", () => {
    const retrieved = [{ anchorId: "b2", excerpt: "A ranked passage." }];

    expect(
      selectDecisionPassages({
        fallback: [{ anchorId: "b1", excerpt: "The full text." }],
        retrieved,
        retrievalFailed: false,
        budgetChars: 100,
      }),
    ).toEqual({
      kind: "passages",
      passages: retrieved,
      retrieved: true,
      retrievalFailed: false,
    });
  });
});
